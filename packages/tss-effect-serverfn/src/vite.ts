import { readFile } from "node:fs/promises";

import * as babel from "@babel/core";
import * as t from "@babel/types";
import type { Plugin } from "vite";

const runtimeModule = "tss-effect-serverfn/compiler-runtime";
const builderMethods = new Set(["middleware", "validator", "handler"]);

const staticName = (node: t.Node) => {
  if (t.isIdentifier(node)) {
    return node.name;
  }

  return t.isStringLiteral(node) ? node.value : undefined;
};

const parseModule = async (code: string, id: string) => {
  const ast = await babel.parseAsync(code, {
    babelrc: false,
    configFile: false,
    filename: id,
    parserOpts: { plugins: ["typescript", "jsx"] },
    sourceType: "module",
  });

  let program: babel.NodePath<t.Program> | undefined;

  if (ast) {
    babel.traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
  }

  if (!ast || !program) {
    throw new Error(`Unable to parse Effect server functions in ${id}`);
  }

  return { ast, program };
};

type ParsedModule = Awaited<ReturnType<typeof parseModule>>;

type ResolveModule = (
  source: string,
  importer: string
) => Promise<string | undefined>;

/**
 * Resolve whether an expression originates from `createEffectServerFn`.
 * Follows lexical bindings, configured builders, and application re-exports;
 * Babel NodePaths preserve scope so shadowed names are not mistaken for imports.
 * Traversal-local visited keys terminate alias and export cycles.
 *
 * @param load - Load an application module with its binding-aware Program path.
 * @param resolve - Resolve imports through Vite's module-resolution rules.
 * @returns An asynchronous predicate over expressions in a module.
 * @throws {Error} When a recognized factory uses unsupported mutable or dynamic composition.
 */
const createFactoryResolver = (
  load: (id: string) => Promise<ParsedModule>,
  resolve: ResolveModule
) => {
  const trace = {
    async factory(
      path: babel.NodePath<t.Node | null | undefined>,
      id: string,
      seen: ReadonlySet<string> = new Set()
    ): Promise<boolean> {
      if (path.isTSAsExpression()) {
        return trace.factory(path.get("expression"), id, seen);
      }

      if (path.isTSSatisfiesExpression()) {
        return trace.factory(path.get("expression"), id, seen);
      }

      if (path.isTSNonNullExpression()) {
        return trace.factory(path.get("expression"), id, seen);
      }

      if (path.isCallExpression()) {
        return trace.factory(path.get("callee"), id, seen);
      }

      if (path.isMemberExpression()) {
        return trace.member(path, id, seen);
      }

      if (path.isImportSpecifier() && path.parentPath.isImportDeclaration()) {
        const { imported } = path.node;

        return trace.imported(
          path.parentPath.node.source.value,
          t.isIdentifier(imported) ? imported.name : imported.value,
          id,
          seen
        );
      }

      if (path.isVariableDeclarator()) {
        return trace.factory(path.get("init"), id, seen);
      }

      if (
        path.isArrowFunctionExpression() &&
        (await trace.factory(path.get("body"), id, seen))
      ) {
        throw new Error(
          `Effect factory wrappers are not supported in ${id}; export a configured builder directly`
        );
      }

      if (!path.isIdentifier()) {
        return false;
      }

      const binding = path.scope.getBinding(path.node.name);
      const key = `${id}:${binding?.scope.uid}:${path.node.name}`;

      if (!binding || seen.has(key)) {
        return false;
      }

      const found = await trace.factory(
        binding.path,
        id,
        new Set([...seen, key])
      );

      if (found && !binding.constant) {
        throw new Error(
          `Mutable Effect factory binding ${path.node.name} in ${id}; use const`
        );
      }

      return found;
    },

    async imported(
      source: string,
      name: string,
      importer: string,
      seen: ReadonlySet<string>
    ): Promise<boolean> {
      if (source === "tss-effect-serverfn") {
        return name === "createEffectServerFn";
      }

      const id = await resolve(source, importer);

      if (
        !id ||
        id.includes("/node_modules/") ||
        id.startsWith("\0") ||
        seen.has(`${id}:${name}`)
      ) {
        return false;
      }

      const next = new Set([...seen, `${id}:${name}`]);
      const { program } = await load(id);
      const stars: string[] = [];

      for (const statement of program.get("body")) {
        if (statement.isExportAllDeclaration()) {
          stars.push(statement.node.source.value);
        }

        if (!statement.isExportNamedDeclaration()) {
          continue;
        }

        for (const specifier of statement.get("specifiers")) {
          if (
            specifier.isExportSpecifier() &&
            staticName(specifier.node.exported) === name
          ) {
            return statement.node.source
              ? trace.imported(
                  statement.node.source.value,
                  specifier.node.local.name,
                  id,
                  next
                )
              : trace.factory(specifier.get("local"), id, next);
          }
        }

        const declaration = statement.get("declaration");

        if (declaration.isVariableDeclaration()) {
          const exported = declaration
            .get("declarations")
            .find((item) => item.get("id").isIdentifier({ name }));

          if (exported) {
            return trace.factory(exported.get("id"), id, next);
          }
        }
      }

      const matches = await Promise.all(
        stars.map((star) => trace.imported(star, name, id, next))
      );

      return matches.some(Boolean);
    },

    async member(
      path: babel.NodePath<t.MemberExpression>,
      id: string,
      seen: ReadonlySet<string>
    ): Promise<boolean> {
      const object = path.get("object");

      if (await trace.factory(object, id, seen)) {
        if (
          path.node.computed ||
          !t.isIdentifier(path.node.property) ||
          !builderMethods.has(path.node.property.name)
        ) {
          throw new Error(
            `Unsupported Effect builder composition in ${id}; use static .middleware(), .validator(), and .handler() calls`
          );
        }

        return true;
      }

      const binding = object.isIdentifier()
        ? object.scope.getBinding(object.node.name)
        : undefined;

      if (
        !path.node.computed &&
        t.isIdentifier(path.node.property) &&
        binding?.path.isImportNamespaceSpecifier() &&
        binding.path.parentPath.isImportDeclaration()
      ) {
        return trace.imported(
          binding.path.parentPath.node.source.value,
          path.node.property.name,
          id,
          seen
        );
      }

      return false;
    },
  };

  return trace.factory;
};

/** Check helper import identity, rather than its local name, to keep lowering idempotent. */
const isAlreadyLowered = (argument: babel.NodePath, helper: string) => {
  if (!argument.isCallExpression() || !t.isIdentifier(argument.node.callee)) {
    return false;
  }

  const binding = argument.scope.getBinding(argument.node.callee.name);

  return (
    binding?.path.isImportSpecifier() &&
    t.isIdentifier(binding.path.node.imported, { name: helper }) &&
    binding.path.parentPath.isImportDeclaration() &&
    binding.path.parentPath.node.source.value === runtimeModule
  );
};

/** Collect syntactic candidates; binding analysis must approve them before rewriting. */
const collectBuilderCalls = (program: babel.NodePath<t.Program>) => {
  const candidates: babel.NodePath<t.CallExpression>[] = [];
  program.traverse({
    CallExpression(path) {
      const { callee } = path.node;

      if (
        t.isMemberExpression(callee) &&
        ["validator", "handler"].includes(staticName(callee.property) ?? "")
      ) {
        candidates.push(path);
      }
    },
  });

  return candidates;
};

/**
 * Wrap validated builder arguments with generated runtime helpers in place.
 * Input paths must already be resolved to Effect builders. Fresh import names
 * avoid lexical collisions; previously lowered arguments remain untouched.
 *
 * @returns Whether any AST nodes and helper imports were added or changed.
 * @throws {Error} For computed methods or calls without exactly one expression argument.
 */
const lowerBuilderCalls = (
  calls: readonly babel.NodePath<t.CallExpression>[],
  program: babel.NodePath<t.Program>,
  id: string
) => {
  const helpers = new Map<string, t.Identifier>();

  for (const call of calls) {
    const { callee } = call.node;

    if (
      !t.isMemberExpression(callee) ||
      callee.computed ||
      !t.isIdentifier(callee.property)
    ) {
      throw new Error(
        `Computed Effect builder methods are unsupported in ${id}`
      );
    }

    const [argument] = call.get("arguments");

    if (call.node.arguments.length !== 1 || !argument?.isExpression()) {
      throw new Error(
        `Effect builders require one schema or handler expression before TanStack compilation in ${id}`
      );
    }

    const helper =
      callee.property.name === "validator" ? "prepareInput" : "effectHandler";

    if (isAlreadyLowered(argument, helper)) {
      continue;
    }

    let local = helpers.get(helper);

    if (!local) {
      local = program.scope.generateUidIdentifier(helper);
      helpers.set(helper, local);
    }

    argument.replaceWith(t.callExpression(local, [argument.node]));
  }

  if (helpers.size === 0) {
    return false;
  }

  program.unshiftContainer(
    "body",
    t.importDeclaration(
      Array.from(helpers, ([name, local]) =>
        t.importSpecifier(local, t.identifier(name))
      ),
      t.stringLiteral(runtimeModule)
    )
  );

  return true;
};

/**
 * Adapt Effect Schemas and handlers before TanStack Start compiles server functions.
 *
 * Install before `tanstackStart()`. The plugin recognizes static builder chains
 * and transparent aliases/re-exports, wraps validator and handler arguments, and
 * emits source maps. Start remains responsible for extraction, RPC identifiers,
 * manifests, and removal of server implementations from browser bundles.
 *
 * @returns A Vite pre-transform plugin with build/watch module-cache invalidation.
 *
 * @example
 * ```ts
 * import { tanstackStart } from "@tanstack/react-start/plugin/vite";
 * import { effectServerFns } from "tss-effect-serverfn/vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [effectServerFns(), tanstackStart()],
 * });
 * ```
 */
export const effectServerFns = (): Plugin => {
  const modules = new Map<string, Promise<ParsedModule>>();

  const load = (id: string) => {
    let module = modules.get(id);

    if (!module) {
      module = (async () => parseModule(await readFile(id, "utf-8"), id))();
      modules.set(id, module);
    }

    return module;
  };

  return {
    buildStart() {
      modules.clear();
    },
    enforce: "pre",
    name: "tss-effect-serverfn",
    async transform(code, id) {
      if (
        !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id) ||
        !/(?:validator|handler)/u.test(code)
      ) {
        return;
      }

      const cleanId = id.split("?")[0] ?? id;
      const { ast, program } = await parseModule(code, cleanId);
      const candidates = collectBuilderCalls(program);

      const isFactory = createFactoryResolver(
        load,
        async (source, importer) => {
          const resolved = await this.resolve(source, importer, {
            skipSelf: true,
          });

          return resolved?.id;
        }
      );

      // Finish binding analysis before mutating paths shared by nested builder calls.
      const resolvedCalls = await Promise.all(
        candidates.map(async (candidate) => {
          const callee = candidate.get("callee");

          return callee.isMemberExpression() &&
            (await isFactory(callee.get("object"), cleanId))
            ? candidate
            : undefined;
        })
      );

      const effectCalls = resolvedCalls.filter((call) => call !== undefined);

      if (!lowerBuilderCalls(effectCalls, program, id)) {
        return;
      }

      const result = await babel.transformFromAstAsync(ast, code, {
        babelrc: false,
        configFile: false,
        filename: cleanId,
        sourceFileName: cleanId,
        sourceMaps: true,
      });

      if (result?.code) {
        return { code: result.code, map: result.map ?? null };
      }
    },
    watchChange() {
      modules.clear();
    },
  };
};
