# Architecture Overview: VMware vCenter → ServiceNow CMDB Integration

## Overview

This integration imports VMware vCenter infrastructure objects into the ServiceNow
CMDB using an IntegrationHub ETL (IH ETL) pipeline with Service Graph Connector
framework principles. All CI identification and reconciliation is handled by the
Identification & Reconciliation Engine (IRE).

---

## High-Level Data Flow

```
VMware vCenter REST API (FT1 Domain)
          │
          │  HTTPS REST (paginated, session-token auth)
          │
     MID Server (FT1)
          │
          │  ECC Queue / REST proxy
          │
  VCenterAPIClient (Script Include)
          │
  ┌───────▼──────────────────────────────────────────┐
  │           VCenterETLOrchestrator                  │
  │                                                   │
  │  Phase 1: Authenticate → session token           │
  │  Phase 2: Extract all object types               │
  │  Phase 3: Load raw data → staging tables         │
  │  Phase 4: Transform staging → IRE payloads       │
  │  Phase 5: Build CMDB relationships               │
  │  Phase 6: Staleness check + CI retirement        │
  │  Phase 7: Run summary + notifications            │
  └───────────────────────────────────────────────────┘
          │
          ▼
  Staging Tables (x_ftl_vcenter_etl_*_stg)
          │
          ▼
  IRE (Identification & Reconciliation Engine)
          │
          ▼
  CMDB Target Tables
  ┌──────────────────────────────────────────┐
  │ cmdb_ci_vcenter          (vCenter)        │
  │ cmdb_ci_datacenter       (Datacenter)     │
  │ cmdb_ci_cluster          (Cluster)        │
  │ cmdb_ci_esx_server       (ESXi Host)      │
  │ cmdb_ci_vmware_instance  (VM)             │
  │ cmdb_ci_datastore        (Datastore)      │
  │ cmdb_ci_storage_pool     (DS Cluster)     │
  │ cmdb_ci_dvs_switch       (DVS)            │
  └──────────────────────────────────────────┘
          │
          ▼
  cmdb_rel_ci (Relationships)
```

---

## Component Architecture

### Scoped Application
**Scope name:** `x_ftl_vcenter_etl`
**Display name:** vCenter CMDB ETL (FT1)

All artifacts are deployed within this scope to ensure isolation, controlled
upgrade paths, and ACL-based access control.

### Script Includes

| Class | Responsibility |
|---|---|
| `VCenterAPIClient` | REST API client — handles auth, pagination, retries |
| `VCenterETLOrchestrator` | Top-level pipeline coordinator |
| `VCenterStagingLoader` | Writes raw API data to staging tables |
| `VCenterTransformEngine` | Reads staging rows, builds IRE payloads, submits |
| `VCenterIREPayloadBuilder` | Constructs IRE-compliant payloads per CI type |
| `VCenterRelationshipBuilder` | Creates `cmdb_rel_ci` records after CI loads |
| `VCenterStalenessManager` | Detects and retires stale CIs |
| `VCenterLogger` | Structured logging to `x_ftl_vcenter_etl_log` |
| `VCenterRetryHandler` | Exponential-backoff retry for REST calls |
| `VCenterConfig` | Centralised sys_properties accessor |
| `VCenterUtils` | Field mapping helpers, type converters |

### Staging Tables

Each vCenter object type has a dedicated staging table extending
`x_ftl_vcenter_etl_staging_base`. The staging layer decouples extraction
from transformation and enables re-processing without re-fetching from vCenter.

| Staging Table | CMDB Target |
|---|---|
| `x_ftl_vcenter_etl_vcenter_stg` | `cmdb_ci_vcenter` |
| `x_ftl_vcenter_etl_datacenter_stg` | `cmdb_ci_datacenter` |
| `x_ftl_vcenter_etl_cluster_stg` | `cmdb_ci_cluster` |
| `x_ftl_vcenter_etl_host_stg` | `cmdb_ci_esx_server` |
| `x_ftl_vcenter_etl_vm_stg` | `cmdb_ci_vmware_instance` |
| `x_ftl_vcenter_etl_datastore_stg` | `cmdb_ci_datastore` |
| `x_ftl_vcenter_etl_ds_cluster_stg` | `cmdb_ci_storage_pool` |
| `x_ftl_vcenter_etl_dvs_stg` | `cmdb_ci_dvs_switch` |

### Supporting Tables

| Table | Purpose |
|---|---|
| `x_ftl_vcenter_etl_log` | Integration log records |
| `x_ftl_vcenter_etl_run` | Per-run history and statistics |

---

## Authentication Flow

```
ServiceNow (MID Server proxy)
    │
    │  POST /api/session
    │  Authorization: Basic <base64(user:pass)>
    │
    ▼
vCenter REST API
    │
    │  201 Created
    │  Body: "<session-token>"
    │
    ▼
Store in VCenterAPIClient.sessionToken
    │
    │  All subsequent requests:
    │  vmware-api-session-id: <token>
    │
    ▼
    ... ETL pipeline ...
    │
    │  DELETE /api/session
    ▼
Session terminated
```

The Connection & Credential Alias holds:
- Base URL: `https://<vcenter-fqdn>/`
- Credential type: Basic Auth (Username + Password)
- MID Server: `<FT1-MID-server-name>`

---

## IRE Identification Strategy

### Identifier Priority per CI Type

| CI Class | Identifier 1 (Strongest) | Identifier 2 | Identifier 3 |
|---|---|---|---|
| `cmdb_ci_vcenter` | `u_instance_uuid` | `correlation_id` (moref/hostname) | `name` |
| `cmdb_ci_datacenter` | `correlation_id` (moref) | `name` | — |
| `cmdb_ci_cluster` | `correlation_id` (moref) | `name` | — |
| `cmdb_ci_esx_server` | `u_bios_uuid` | `correlation_id` (moref) | `name` (FQDN) |
| `cmdb_ci_vmware_instance` | `u_instance_uuid` | `u_bios_uuid` | `correlation_id` (moref) |
| `cmdb_ci_datastore` | `correlation_id` (moref) | `name` | — |
| `cmdb_ci_storage_pool` | `correlation_id` (moref) | `name` | — |
| `cmdb_ci_dvs_switch` | `u_dvs_uuid` | `correlation_id` (moref) | `name` |

All CIs use `correlation_id` = vCenter MoRef as the universal fallback.
MoRefs are stable within a vCenter instance but not globally unique across
multiple vCenter instances — this is why stronger UUIDs take priority.

---

## Relationship Model

```
cmdb_ci_vcenter
  └─[Contains]── cmdb_ci_datacenter
                    └─[Contains]── cmdb_ci_cluster
                                     ├─[Contains]── cmdb_ci_esx_server
                                     │                └─[Hosts]─── cmdb_ci_vmware_instance
                                     │                               └─[Uses]── cmdb_ci_datastore
                                     └─[Uses]──── cmdb_ci_datastore
                    └─[Contains]── cmdb_ci_storage_pool

cmdb_ci_dvs_switch
  └─[Connects]── cmdb_ci_esx_server
```

Relationship types used from `cmdb_rel_type`:
- `Contains::Contained by`
- `Hosts::Hosted by`
- `Uses::Used by`
- `Connects::Connected by`

---

## Scheduling Architecture

```
00:00 UTC+0  →  Scheduled Job triggers (sysauto_script)
                 │
                 ├── Time window check: 00:00–02:00 ✓
                 ├── Concurrency check: no other run in progress ✓
                 │
                 └── VCenterETLOrchestrator.run()
                       │
                       ├── ~00:01  Phase 1: Auth
                       ├── ~00:02  Phase 2+3: Extract + Stage
                       │           (runtime depends on VM count)
                       │           Expected: 5-30 min for 5000 VMs
                       ├── ~00:30  Phase 4: Transform (IRE)
                       ├── ~01:30  Phase 5: Relationships
                       ├── ~01:45  Phase 6: Staleness
                       └── ~01:55  Phase 7: Summary
```

Total expected runtime: 45–90 minutes for a typical environment with
5,000 VMs and 200 hosts.

---

## Discovery Source

All CI writes use `discovery_source = vCenterETL`.

This ensures:
1. IRE reconciliation rules apply correctly
2. Staleness detection targets only ETL-owned CIs
3. IRE ownership attributes (`discovery_source`) enable conflict resolution
   if another discovery source also manages overlapping CIs

---

## Deployment Domain

- Domain: **FT1**
- MID Server: Must be in FT1 domain with network access to vCenter FQDN
- CMDB writes: Executed in MID Server's domain context

---

## Security Considerations

1. Credentials stored in ServiceNow Credential Store (not plain text properties)
2. All vCenter communication over HTTPS
3. Session tokens are ephemeral (deleted after each ETL run)
4. Scoped app restricts table access via ACLs
5. Integration user account should have read-only vCenter API access
6. MID Server should be firewall-limited to vCenter FQDN:443 only
