/**
 * Shared shape of the "point an existing replica at a new primary" script
 * for MySQL-family engines. Only the keywords differ between dialects.
 */

export type FollowSourceDialect = {
  stop: string;
  change: string;
  hostKey: string;
  portKey: string;
  start: string;
};

export function renderFollowSourceSql(
  dialect: FollowSourceDialect,
  spec: { host: string; port: number },
  quoteLiteral: (value: string) => string,
): string {
  return [
    `${dialect.stop};`,
    `${dialect.change}`,
    `  ${dialect.hostKey} = ${quoteLiteral(spec.host)},`,
    `  ${dialect.portKey} = ${spec.port};`,
    `${dialect.start};`,
  ].join("\n");
}
