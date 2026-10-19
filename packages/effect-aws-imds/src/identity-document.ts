import { Effect, Schema } from "effect";

const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed(null))
  );

/**
 * Schema for the EC2 instance identity document served at
 * `/latest/dynamic/instance-identity/document`.
 *
 * Unknown keys are ignored so that fields AWS adds later do not break decoding.
 *
 * @since 0.1.0
 */
// oxlint-disable-next-line no-redeclare -- The decoded type below intentionally shares the schema's name.
export const IdentityDocument = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^\d{12}$/u)).annotateKey({
    description: "The ID of the AWS account that launched the instance.",
  }),
  architecture: Schema.Literals(["i386", "x86_64", "arm64"]).annotateKey({
    description: "The architecture of the AMI used to launch the instance.",
  }),
  availabilityZone: Schema.NonEmptyString.annotateKey({
    description: "The Availability Zone in which the instance is running.",
  }),
  billingProducts: optionalNullable(Schema.Array(Schema.String)).annotateKey({
    description: "The billing products of the instance.",
  }),
  devpayProductCodes: optionalNullable(Schema.Array(Schema.String)).annotateKey(
    { description: "Deprecated AWS DevPay product codes of the AMI." }
  ),
  imageId: Schema.String.check(
    Schema.isPattern(/^ami-[0-9a-f]+$/iu)
  ).annotateKey({
    description: "The ID of the AMI used to launch the instance.",
  }),
  instanceId: Schema.String.check(
    Schema.isPattern(/^i-[0-9a-f]+$/iu)
  ).annotateKey({ description: "The ID of the instance." }),
  instanceType: Schema.NonEmptyString.annotateKey({
    description: "The instance type of the instance.",
  }),
  kernelId: optionalNullable(Schema.String).annotateKey({
    description: "The ID of the kernel associated with the instance.",
  }),
  marketplaceProductCodes: optionalNullable(
    Schema.Array(Schema.String)
  ).annotateKey({
    description: "The AWS Marketplace product codes of the AMI.",
  }),
  pendingTime: Schema.DateFromString.annotateKey({
    description: "The date and time that the instance was launched.",
  }),
  privateIp: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isTrimmed()
  ).annotateKey({
    description:
      "The private IPv4 address, or IPv6 address on IPv6-only instances.",
  }),
  ramdiskId: optionalNullable(Schema.String).annotateKey({
    description: "The ID of the RAM disk associated with the instance.",
  }),
  region: Schema.String.check(
    Schema.isPattern(/^[a-z]{2,}(?:-[a-z]+)+-\d+$/u)
  ).annotateKey({
    description: "The Region in which the instance is running.",
  }),
  version: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)
  ).annotateKey({
    description: "The version of the identity document format.",
  }),
}).annotate({
  identifier: "IdentityDocument",
  title: "EC2 Instance Identity Document",
});

/**
 * A decoded EC2 instance identity document.
 *
 * @since 0.1.0
 */
export type IdentityDocument = typeof IdentityDocument.Type;
