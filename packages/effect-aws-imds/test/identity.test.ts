import { describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import * as AwsImds from "../src/index.ts";
import { count, document, fakeImds, text } from "./fixtures.ts";

const { addedByAwsLater: _extra, ...wire } = document;

const decode = Schema.decodeUnknownExit(AwsImds.IdentityDocument);

type Override = Partial<
  Record<keyof typeof wire, string | readonly string[] | null>
>;

// Modelled on the example in the EC2 User Guide's instance identity documents page.
const awsDocumentationExample = {
  accountId: "123456789012",
  architecture: "x86_64",
  availabilityZone: "us-west-2b",
  billingProducts: null,
  devpayProductCodes: null,
  imageId: "ami-5fb8c835",
  instanceId: "i-1234567890abcdef0",
  instanceType: "t2.micro",
  kernelId: null,
  marketplaceProductCodes: ["1abc2defghijklm3nopqrs4tu"],
  pendingTime: "2016-11-19T16:32:11Z",
  privateIp: "10.158.112.84",
  ramdiskId: null,
  region: "us-west-2",
  version: "2017-09-30",
};

describe("IdentityDocument schema", () => {
  it("decodes the example document from the AWS documentation", () => {
    const decoded = Schema.decodeUnknownSync(AwsImds.IdentityDocument)(
      awsDocumentationExample
    );

    expect(decoded.marketplaceProductCodes).toEqual([
      "1abc2defghijklm3nopqrs4tu",
    ]);
    expect(decoded.pendingTime).toEqual(new Date("2016-11-19T16:32:11Z"));
  });

  const accepted: readonly (readonly [string, Override])[] = [
    ["a GovCloud region", { region: "us-gov-west-1" }],
    ["a China region", { region: "cn-north-1" }],
    ["an ISO partition region", { region: "us-iso-east-1" }],
    ["the European Sovereign Cloud", { region: "eusc-de-east-1" }],
    ["a two-digit region number", { region: "ap-southeast-10" }],
    ["an IPv6 private address", { privateIp: "2600:1f14:abcd::1" }],
    ["uppercase hex in IDs", { imageId: "ami-0ABCDEF", instanceId: "i-0ABC" }],
    ["each architecture: i386", { architecture: "i386" }],
    ["each architecture: arm64", { architecture: "arm64" }],
    ["billing products", { billingProducts: ["bp-6ba54002"] }],
  ];

  for (const [label, override] of accepted) {
    it(`accepts ${label}`, () => {
      expect(Exit.isSuccess(decode({ ...wire, ...override }))).toBe(true);
    });
  }

  const rejected: readonly (readonly [string, Override])[] = [
    ["an 11-digit account", { accountId: "12345678901" }],
    ["a non-numeric account", { accountId: "12345678901a" }],
    ["an unknown architecture", { architecture: "riscv64" }],
    ["an AMI without the ami- prefix", { imageId: "0abcdef" }],
    ["an instance without the i- prefix", { instanceId: "0abcdef" }],
    ["non-hex instance characters", { instanceId: "i-xyz" }],
    ["a region without a number", { region: "us-east" }],
    ["an uppercase region", { region: "US-EAST-1" }],
    ["a malformed version", { version: "2017-9-30" }],
    ["an unparseable launch time", { pendingTime: "yesterday" }],
    ["a private IP with whitespace", { privateIp: " 10.0.0.12" }],
    ["an empty availability zone", { availabilityZone: "" }],
    ["an empty instance type", { instanceType: "" }],
  ];

  for (const [label, override] of rejected) {
    it(`rejects ${label}`, () => {
      expect(Exit.isFailure(decode({ ...wire, ...override }))).toBe(true);
    });
  }

  for (const field of [
    "accountId",
    "architecture",
    "availabilityZone",
    "imageId",
    "instanceId",
    "instanceType",
    "pendingTime",
    "privateIp",
    "region",
    "version",
  ] as const satisfies readonly (keyof typeof wire)[]) {
    it(`requires ${field}`, () => {
      const { [field]: _removed, ...incomplete } = wire;
      expect(Exit.isFailure(decode(incomplete))).toBe(true);
    });
  }
});

describe("InstanceIdentity service", () => {
  it.effect("shares one request between concurrent document reads", () => {
    const imds = fakeImds({ get: () => text(JSON.stringify(wire)) });

    return Effect.gen(function* concurrentDocuments() {
      const documents = yield* Effect.all(
        [
          AwsImds.identityDocument,
          AwsImds.identityDocument,
          AwsImds.identityDocument,
        ],
        { concurrency: 3 }
      );

      expect(new Set(documents.map((doc) => doc.instanceId))).toEqual(
        new Set([wire.instanceId])
      );
      expect(count(imds.requests, "GET")).toBe(1);
    }).pipe(Effect.provide(imds.layer()));
  });

  it.effect(
    "re-reads the document after invalidate but keeps the token",
    () => {
      const imds = fakeImds({ get: () => text(JSON.stringify(wire)) });

      return Effect.gen(function* invalidateDocument() {
        yield* AwsImds.identityDocument;
        yield* AwsImds.InstanceIdentity.use((identity) => identity.invalidate);
        yield* AwsImds.identityDocument;

        expect(count(imds.requests, "GET")).toBe(2);
        expect(count(imds.requests, "PUT")).toBe(1);
      }).pipe(Effect.provide(imds.layer()));
    }
  );

  it.effect("fails with the document path when the body is not JSON", () => {
    const imds = fakeImds({ get: () => text("<html>not json</html>") });

    return Effect.gen(function* notJson() {
      const error = yield* Effect.flip(AwsImds.identityDocument);

      expect(error).toBeInstanceOf(AwsImds.AwsImdsMetadataError);
      expect(error).toMatchObject({
        path: "/latest/dynamic/instance-identity/document",
      });
      expect(error).not.toHaveProperty("status");
    }).pipe(Effect.provide(imds.layer()));
  });
});
