# VMware vCenter → ServiceNow CMDB Integration v2

Production-ready integration that imports VMware vCenter infrastructure objects
into the ServiceNow CMDB using IntegrationHub ETL principles, Service Graph
Connector patterns, and the Identification & Reconciliation Engine (IRE).

---

## Architecture Summary

```
vCenter REST API (FT1 Domain)
    ↓ HTTPS (MID Server proxy)
VCenterAPIClient
    ↓
VCenterETLOrchestrator
    ├── Extract → VCenterAPIClient (pagination, retry, session auth)
    ├── Stage   → VCenterStagingLoader (8 staging tables, upsert by MoRef)
    ├── Transform → VCenterTransformEngine + VCenterIREPayloadBuilder → IRE
    ├── Relate  → VCenterRelationshipBuilder (cmdb_rel_ci)
    └── Retire  → VCenterStalenessManager
```

**Discovery Source:** `vCenterETL`  
**Scoped App Scope:** `x_ftl_vcenter_etl`  
**Schedule:** Daily 00:00–02:00

---

## CI Types Supported

| vCenter Object | CMDB Class | Primary Identifier |
|---|---|---|
| vCenter Instance | `cmdb_ci_vcenter` | `u_instance_uuid` |
| Datacenter | `cmdb_ci_datacenter` | `correlation_id` (MoRef) |
| Compute Cluster | `cmdb_ci_cluster` | `correlation_id` (MoRef) |
| ESXi Host | `cmdb_ci_esx_server` | `u_bios_uuid` |
| Virtual Machine | `cmdb_ci_vmware_instance` | `u_instance_uuid` |
| Datastore | `cmdb_ci_datastore` | `correlation_id` (MoRef) |
| Datastore Cluster | `cmdb_ci_storage_pool` | `correlation_id` (MoRef) |
| Distributed vSwitch | `cmdb_ci_dvs_switch` | `u_dvs_uuid` |

---

## Repository Structure

```
.
├── servicenow/
│   ├── script_includes/          # All ServiceNow Script Include source files
│   │   ├── VCenterAPIClient.script.js
│   │   ├── VCenterETLOrchestrator.script.js
│   │   ├── VCenterStagingLoader.script.js
│   │   ├── VCenterTransformEngine.script.js
│   │   ├── VCenterIREPayloadBuilder.script.js
│   │   ├── VCenterRelationshipBuilder.script.js
│   │   ├── VCenterStalenessManager.script.js
│   │   ├── VCenterLogger.script.js
│   │   ├── VCenterRetryHandler.script.js
│   │   ├── VCenterConfig.script.js
│   │   └── VCenterUtils.script.js
│   ├── tables/                   # Staging table XML definitions (Update Set format)
│   │   ├── x_ftl_vcenter_etl_staging_base.xml
│   │   ├── x_ftl_vcenter_etl_vcenter_stg.xml
│   │   ├── x_ftl_vcenter_etl_datacenter_stg.xml
│   │   ├── x_ftl_vcenter_etl_cluster_stg.xml
│   │   ├── x_ftl_vcenter_etl_host_stg.xml
│   │   ├── x_ftl_vcenter_etl_vm_stg.xml
│   │   ├── x_ftl_vcenter_etl_datastore_stg.xml
│   │   ├── x_ftl_vcenter_etl_ds_cluster_stg.xml
│   │   ├── x_ftl_vcenter_etl_dvs_stg.xml
│   │   └── x_ftl_vcenter_etl_log.xml       # Log + Run tables
│   ├── transform_scripts/        # ETL Transform Map scripts (one per CI type)
│   ├── scheduled_jobs/           # Daily import job script
│   ├── business_rules/           # CI retirement cascade BR
│   ├── data_sources/             # REST Data Source + sys_properties XML
│   └── flows/                    # Flow Designer documentation
├── mock/
│   ├── payloads/                 # Sample vCenter API JSON responses
│   └── server/                   # Node.js mock vCenter API server
├── tests/
│   ├── unit/                     # Script Include unit test scripts
│   └── integration/              # Full pipeline integration tests
├── docs/
│   ├── architecture-overview.md
│   ├── build-guide.md            # Step-by-step ServiceNow build instructions
│   ├── ire-strategy.md           # IRE identification & reconciliation strategy
│   ├── mid-server-config.md      # MID Server setup guide
│   └── testing-strategy.md       # Testing approach (unit / mock / production)
└── deployment/
    ├── app-manifest.xml          # Scoped app sys_app record
    ├── update-set-guide.md       # Update Set export/import instructions
    └── reconciliation-strategy.md # Data quality & staleness strategy
```

---

## Quick Start

### Option A: Development with Mock Server (No vCenter Required)

```bash
# 1. Start mock vCenter API
cd mock/server
npm install
node mock_vcenter_api.js 8080

# 2. In ServiceNow PDI, create Connection Alias pointing to:
#    http://<your-ip>:8080
#    with any Basic Auth credentials

# 3. Set properties:
#    x_ftl_vcenter_etl.vcenter_host     = <your-ip>:8080
#    x_ftl_vcenter_etl.connection_alias = x_ftl_vcenter_etl.vcenter_conn_mock

# 4. In Background Scripts, run:
var o = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
gs.info(JSON.stringify(o.run()));
```

### Option B: Production Deployment

See `docs/build-guide.md` for the complete step-by-step guide.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| MID Server for all REST calls | vCenter is in FT1 domain, not reachable from ServiceNow directly |
| IRE for CI identification | Prevents duplicates, handles CI merges, supports multi-source |
| Staging tables | Decouples extraction from transformation; enables re-processing |
| MoRef as `correlation_id` | Stable, unique within a vCenter; survives renames |
| `u_instance_uuid` as primary VM key | Globally unique; survives vMotion |
| `u_bios_uuid` as primary ESXi key | Survives MoRef changes on vCenter migration |
| Full sync by default | Simplest staleness model; incremental configurable |
| `discovery_source = vCenterETL` | All writes tagged; enables staleness detection and IRE ownership |

---

## Relationship Map

```
cmdb_ci_vcenter
  └── Contains ── cmdb_ci_datacenter
                    └── Contains ── cmdb_ci_cluster
                                      ├── Contains ── cmdb_ci_esx_server
                                      │                 └── Hosts ── cmdb_ci_vmware_instance
                                      │                               └── Uses ── cmdb_ci_datastore
                                      └── Uses ─── cmdb_ci_datastore

cmdb_ci_dvs_switch
  └── Connects ── cmdb_ci_esx_server
```

---

## Configuration Reference

| Property | Description | Default |
|---|---|---|
| `x_ftl_vcenter_etl.connection_alias` | Connection & Credential Alias name | (required) |
| `x_ftl_vcenter_etl.mid_server` | MID Server name | (required) |
| `x_ftl_vcenter_etl.vcenter_host` | vCenter FQDN | (required) |
| `x_ftl_vcenter_etl.discovery_source` | Discovery source label | `vCenterETL` |
| `x_ftl_vcenter_etl.log_level` | Log verbosity | `INFO` |
| `x_ftl_vcenter_etl.page_size` | API page size | `200` |
| `x_ftl_vcenter_etl.max_retries` | HTTP retry count | `3` |
| `x_ftl_vcenter_etl.staleness_days` | Days before CI retirement | `7` |
| `x_ftl_vcenter_etl.batch_size` | IRE batch size | `50` |
| `x_ftl_vcenter_etl.notify_email` | Failure notification email | (blank) |

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| vCenter session timeout mid-run | Session refresh via re-authenticate in retry handler |
| MID Server unavailability | ETL fails gracefully; next daily run retries |
| Large VM count (10,000+) | Paginated fetch (200/page); batch IRE (50/batch) |
| Duplicate BIOS UUIDs on cloned hardware | Instance UUID takes priority for VMs |
| IRE identification failure | Falls back to coalesce on `correlation_id` |
| CMDB governor limits | Batch processing; session scoped transactions |
| vCenter API rate limiting | Retry handler with exponential backoff (2s, 4s, 8s) |
| Network timeout | `timeout_ms` configurable; default 30s per request |

---

## Recommended Enhancements (Roadmap)

1. **Incremental Sync** — Use `filter.filter.timestamp` to fetch only changed objects
2. **vCenter Tags → CMDB** — Import vCenter tags as CMDB attributes
3. **Network Adapter Detail** — Import VM NIC IP addresses into `cmdb_ci_network_adapter`
4. **Disk Detail** — Import individual VMDK records into `cmdb_ci_disk`
5. **Multi-vCenter** — Loop over multiple vCenter instances from config
6. **Health Dashboard** — PA dashboard for ETL run metrics and CMDB quality KPIs
7. **ATF Tests** — Full Automated Test Framework coverage
8. **ITSM Integration** — Auto-create Change Requests for large CI population shifts

---

## Support

- Issues: Create a GitHub issue in this repository
- Architecture questions: Reference `docs/architecture-overview.md`
- Build issues: Reference `docs/build-guide.md`
- ServiceNow MID Server: Reference `docs/mid-server-config.md`
