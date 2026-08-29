# Source lineage

Watchtower is a bounded extraction from the immutable Hearth production
baseline below. No file was sourced from Hearth local HEAD, a PostgreSQL pull
request, an integration branch, or an Azure rehearsal environment.

| Identity | Value |
| --- | --- |
| Repository | `EnzoLopez2023/Hearth` |
| Version | `2.13.2` |
| Build | `172` |
| Commit | `f0b05fc1dbf53e8aa26c215d8e858894a2793871` |
| Tree | `62cbd35861c511f7c17187c875d19ee6e353b80d` |
| Production workflow run | `32935405922` |
| Production image | `sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140` |

Every Hearth file body used during extraction was read as:

```sh
git -C "/Users/enzo/repos/VSCode - React/Hearth" \
  show f0b05fc1dbf53e8aa26c215d8e858894a2793871:<path>
```

## Database source

The source is a database-native production backup, never the live authority:

| Evidence | Value |
| --- | --- |
| Backup created | `2026-08-28T05:36:25.317Z` |
| Bytes | `950947840` |
| SHA-256 | `dc9fb47d269b339a3dcae37279dc3116f37a0635728a2d2b2ac2c511811a5807` |
| Schema objects | 101 application tables, 137 indexes, 8 triggers |
| Independent checks | `quick_check=ok`, `integrity_check=ok`, zero FK violations |
| Watchtower owned data | 54 tables, 2,723,313 rows |
| Watchtower canonical hash | `f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322` |

Import refuses a source whose immutable identity differs. Reconciliation uses
both mapping-aware target evidence and the separately generated source-side
canonical per-table hash oracle.

## Extracted source boundary

Frontend parity was derived only from:

- `src/AzureCommandCenter.tsx`
- `src/SystemStatus.tsx`
- `src/ObservabilityConsole/**`
- `src/UpsMonitor.tsx`
- `src/PowerTopology/**`
- `src/UniFiNetwork.tsx`
- `src/UniFiTopology.tsx`
- `src/UniFiConfig.tsx`
- `src/Synology.tsx`
- `src/IpMigration.tsx`
- `src/Protect.tsx`
- `src/components/unifi/**`

Backend parity was derived only from the 12 owned route modules and the alert,
archive, outage, and off-host worker modules listed in
[`OWNERSHIP.md`](OWNERSHIP.md), plus their exact transitive dependencies and
tests. The Hearth shell, view registry, unrelated routes, shared database, and
cross-product search index were not copied.

The immutable source identity is compiled into the application and returned by
`/api/version` and `/version.json`.

