/**
 * Socket-auth platform admins for the MySQL family.
 *
 * MySQL and MariaDB differ only in how the account is identified
 * (`WITH auth_socket` / `VIA unix_socket`), which the caller supplies along
 * with its own quoted `root@localhost` and OS-user accounts.
 */
export function socketAdminSql(
  rootAccount: string,
  osAccount: string,
  identified: string,
): string {
  return [
    // The image also creates root@'%' with the cluster root password; that
    // account would let root log in from any host on the datacenter network
    // (and, on MariaDB, write on a replica). Only the socket admin stays.
    "DROP USER IF EXISTS `root`@'%';",
    ...[rootAccount, osAccount].flatMap((account) => [
      `CREATE USER IF NOT EXISTS ${account} IDENTIFIED ${identified};`,
      `ALTER USER ${account} IDENTIFIED ${identified};`,
      `GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION;`,
    ]),
  ].join("\n");
}
