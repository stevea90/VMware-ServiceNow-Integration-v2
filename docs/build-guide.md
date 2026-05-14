# Step-by-Step Build Guide

## Prerequisites

| Item | Requirement |
|---|---|
| ServiceNow instance | Tokyo or later (PDI or sandbox) |
| Role | `admin` on PDI; `x_ftl_vcenter_etl.etl_admin` on non-PDI |
| MID Server | Deployed and validated (see mid-server-config.md) |
| vCenter access | Read-only API service account |
| Git repo access | This repository cloned locally |

---

## Phase 1: Create Scoped Application

### 1.1 Create the App

Navigate to: **System Applications > Studio > Create Application**

```
Name:         vCenter CMDB ETL (FT1)
Scope:        x_ftl_vcenter_etl
Version:      1.0.0
Short desc:   VMware vCenter → ServiceNow CMDB integration via IH ETL
```

Click **Create**.

### 1.2 Set Application Properties

In Studio, open the application:
- **Description:** Full ETL pipeline for importing vCenter vms, hosts, clusters,
  datacenters, datastores, and distributed switches into the ServiceNow CMDB
  using IRE for identification and reconciliation.
- **Roles:** Create roles `x_ftl_vcenter_etl.etl_admin` and
  `x_ftl_vcenter_etl.etl_user`

---

## Phase 2: Create Custom Tables

Create each table in Studio: **Create Application File > Table**

### 2.1 Create Staging Base Table

```
Table label:  vCenter ETL Staging Base
Table name:   x_ftl_vcenter_etl_staging_base
Extends:      (none — base table)
Auto-number:  false

Fields to add:
  moref        String(255)    MoRef
  run_id       String(50)     Run ID
  stg_state    String(20)     State  [default: ready]
  raw_payload  String(8000)   Raw Payload
  last_seen    Date/Time      Last Seen
  error_msg    String(1000)   Error Message
```

### 2.2 Create All Staging Tables

Repeat for each table, setting **Extends = x_ftl_vcenter_etl_staging_base**:

| Table | Additional Fields |
|---|---|
| `x_ftl_vcenter_etl_vcenter_stg` | name, vcenter_fqdn, version, build, instance_uuid, api_version |
| `x_ftl_vcenter_etl_datacenter_stg` | name, vcenter_ref |
| `x_ftl_vcenter_etl_cluster_stg` | name, datacenter_ref, ha_enabled, drs_enabled, num_hosts |
| `x_ftl_vcenter_etl_host_stg` | name, cluster_ref, datacenter_ref, power_state, connection_state, cpu_count, cpu_cores, memory_size_gb, model, vendor, bios_uuid, os_type |
| `x_ftl_vcenter_etl_vm_stg` | name, instance_uuid, bios_uuid, host_ref, cluster_ref, datacenter_ref, resource_pool_ref, power_state, cpu_count, cpu_cores_per_socket, memory_size_gb, guest_os, guest_hostname, num_disks, num_nics, hardware_version, datastore_refs |
| `x_ftl_vcenter_etl_datastore_stg` | name, type, capacity_gb, free_space_gb, accessible, datacenter_ref, host_ref, cluster_ref |
| `x_ftl_vcenter_etl_ds_cluster_stg` | name, sdrs_enabled, capacity_gb, free_space_gb, datacenter_ref |
| `x_ftl_vcenter_etl_dvs_stg` | name, type, dvs_uuid, datacenter_ref, num_ports, uplink_count, host_refs |

### 2.3 Create Log and Run Tables

| Table | Fields |
|---|---|
| `x_ftl_vcenter_etl_log` | level(String 10), source(String 100), run_id(String 50), message(String 1000), detail(String 4000) |
| `x_ftl_vcenter_etl_run` | run_id, status, started_at, ended_at, vcenter, current_phase, stats_json |

---

## Phase 3: Create Script Includes

In Studio: **Create Application File > Script Include**

Create one Script Include per file in `servicenow/script_includes/`.

### Order of creation (dependency order):

1. `VCenterLogger` — no dependencies
2. `VCenterRetryHandler` — no dependencies
3. `VCenterUtils` — no dependencies
4. `VCenterConfig` — no dependencies
5. `VCenterAPIClient` — depends on Logger, Retry, Config
6. `VCenterStagingLoader` — depends on Logger, Utils, Config
7. `VCenterIREPayloadBuilder` — depends on Logger, Utils, Config
8. `VCenterRelationshipBuilder` — depends on Logger, Utils
9. `VCenterStalenessManager` — depends on Logger, Config
10. `VCenterTransformEngine` — depends on Logger, IRE, Config
11. `VCenterETLOrchestrator` — depends on all above

For each Script Include:
```
Name:             VCenterLogger
API Name:         x_ftl_vcenter_etl.VCenterLogger
Client callable:  false
Active:           true
Script:           [paste from script_includes/VCenterLogger.script.js]
```

---

## Phase 4: Configure System Properties

Navigate to: **System Properties > All Properties > New**

Create each property from `servicenow/data_sources/vcenter_rest_datasource.xml`.

Critical properties to set immediately:
```
x_ftl_vcenter_etl.connection_alias  = x_ftl_vcenter_etl.vcenter_conn
x_ftl_vcenter_etl.mid_server        = MID-FT1-VCENTER-01
x_ftl_vcenter_etl.vcenter_host      = vcenter-ft1.corp.example.com
x_ftl_vcenter_etl.discovery_source  = vCenterETL
x_ftl_vcenter_etl.log_level         = INFO
x_ftl_vcenter_etl.page_size         = 200
x_ftl_vcenter_etl.max_retries       = 3
x_ftl_vcenter_etl.staleness_days    = 7
x_ftl_vcenter_etl.batch_size        = 50
```

---

## Phase 5: Configure Connection & Credential Alias

See `docs/mid-server-config.md` for full instructions.

Summary:
1. Create Credential record (Basic Auth — vCenter service account)
2. Create Connection record (HTTPS to vCenter FQDN, MID Server selected)
3. Create Connection Alias: `x_ftl_vcenter_etl.vcenter_conn`

---

## Phase 6: Configure IRE Identification Rules

Navigate to: **CMDB > Identification and Reconciliation > Identification Rules**

Create identification rules per `docs/ire-strategy.md`.

Key rules (minimum required):

**ESXi Host:**
```
CI Class:     ESX Server (cmdb_ci_esx_server)
Rule Name:    vCenter ETL - BIOS UUID
Priority:     1
Identifier:   u_bios_uuid (Independent)
```

**Virtual Machine:**
```
CI Class:     VMware Virtual Machine Instance (cmdb_ci_vmware_instance)
Rule Name:    vCenter ETL - Instance UUID
Priority:     1
Identifier:   u_instance_uuid (Independent)
```

**DVS:**
```
CI Class:     cmdb_ci_dvs_switch
Rule Name:    vCenter ETL - DVS UUID
Priority:     1
Identifier:   u_dvs_uuid (Independent)
```

For all other types: use `correlation_id` as the primary identifier.

---

## Phase 7: Configure CMDB Custom Fields

Add custom fields to CMDB target tables for vCenter-specific attributes:

### cmdb_ci_esx_server additions:
```
u_bios_uuid     String(100)   BIOS UUID
u_moref         String(255)   vCenter MoRef
```

### cmdb_ci_vmware_instance additions:
```
u_instance_uuid  String(100)  Instance UUID
u_bios_uuid      String(100)  BIOS UUID
u_moref          String(255)  vCenter MoRef
u_cores_per_socket Integer    Cores per Socket
```

### cmdb_ci_vcenter additions:
```
u_instance_uuid  String(100)  Instance UUID
u_build          String(50)   Build Number
```

### cmdb_ci_cluster additions:
```
u_ha_enabled    Boolean       HA Enabled
u_drs_enabled   Boolean       DRS Enabled
u_moref         String(255)   vCenter MoRef
```

### cmdb_ci_dvs_switch additions:
```
u_dvs_uuid      String(100)   DVS UUID
u_num_ports     Integer       Number of Ports
u_uplink_count  Integer       Uplink Count
u_moref         String(255)   vCenter MoRef
```

### cmdb_ci_datastore additions:
```
u_type          String(30)    Datastore Type (NFS/VMFS/etc.)
u_free_space_gb Decimal       Free Space (GB)
u_accessible    Boolean       Accessible
u_moref         String(255)   vCenter MoRef
```

---

## Phase 8: Create Transform Maps

In Studio: **Create Application File > Transform Map**

Create one Transform Map per object type.

### Example: ESXi Host Transform Map

```
Name:          vCenter ETL - ESXi Host → cmdb_ci_esx_server
Source Table:  x_ftl_vcenter_etl_host_stg
Target Table:  cmdb_ci_esx_server
Active:        true
Run Business Rules: false
Copy empty fields: false
```

**Field Map:**

| Source Field | Target Field | Coalesce |
|---|---|---|
| moref | correlation_id | ✓ (primary) |
| bios_uuid | u_bios_uuid | ✓ (secondary) |
| name | name | |
| cpu_count | cpu_count | |
| cpu_cores | cpu_core_count | |
| model | model_id | |
| vendor | manufacturer | |
| os_type | os | |
| (script) | ram | |
| (script) | operational_status | |
| (script) | install_status | |
| (constant: vCenterETL) | discovery_source | |

**Script (onBefore):** Paste from `servicenow/transform_scripts/esx_host_transform.js`

---

## Phase 9: Create Scheduled Job

Navigate to: **System Definition > Scheduled Jobs > New**

```
Name:       vCenter CMDB Daily Import
Type:       Automatically run a script
Script:     [paste from scheduled_jobs/VCenterDailyImportJob.js]
Run:        Daily
Time:       00:00:00
Active:     true
Run as:     svc-vcenter-etl   (service account with etl_user role)
```

---

## Phase 10: Create Business Rules

Navigate to: **System Definition > Business Rules > New**

```
Name:       vCenter ETL - CI Retirement Cascade
Table:      Configuration Item [cmdb_ci]
When:       Before
Insert:     false
Update:     true
Condition:  current.discovery_source == 'vCenterETL' &&
            current.install_status.changesTo('7')
Script:     [paste from business_rules/vcenter_staleness_br.js]
```

---

## Phase 11: Run Initial Test

1. Open **System Definition > Scripts - Background**
2. Paste and run the integration test from `docs/testing-strategy.md`
3. Validate results in CMDB

---

## Phase 12: Enable Production Scheduling

Once testing is complete:
1. Set `x_ftl_vcenter_etl.log_level = INFO`
2. Enable the scheduled job
3. Monitor first scheduled run at 00:00

---

## Rollback Procedure

If the integration needs to be rolled back:

1. Disable the scheduled job
2. (Optional) Retire all ETL-managed CIs:
   ```javascript
   // Run in Background Script
   var tables = ['cmdb_ci_esx_server','cmdb_ci_vmware_instance',...];
   tables.forEach(function(t) {
       var gr = new GlideRecord(t);
       gr.addQuery('discovery_source', 'vCenterETL');
       gr.setValue('install_status', '7');
       gr.updateMultiple();
   });
   ```
3. Export the Update Set and save as backup
4. Delete application if full removal required
