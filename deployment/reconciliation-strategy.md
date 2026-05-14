# Reconciliation & Data Quality Strategy

## Reconciliation Overview

The reconciliation strategy ensures that:
1. CIs are not duplicated when re-imported
2. CI attributes are updated with fresh values each run
3. Stale CIs (removed from vCenter) are retired — never silently lingering
4. Attribute ownership conflicts between discovery sources are resolved predictably

---

## Reconciliation Workflow per Run

```
┌─────────────────────────────────────────────────────────────┐
│  Step 1: EXTRACT                                             │
│  Pull ALL objects from vCenter API (full sync by default)   │
│  Incremental option: filter.filter.timestamp if supported   │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Step 2: STAGE                                               │
│  Upsert into staging table (key = MoRef)                    │
│  Set last_seen = now(), stg_state = ready                   │
│  Record not in current pull: stg_state remains from prev    │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Step 3: IDENTIFY (IRE)                                      │
│  For each staging row: call IRE with identifier priority     │
│  IRE returns: matched sys_id OR creates new CI               │
│  IRE applies reconciliation rules for field ownership        │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Step 4: RECONCILE (Attribute Update)                        │
│  IRE updates CI fields per reconciliation rule ownership     │
│  ETL updates: operational_status, install_status, hardware  │
│  vCenter is authoritative for virtualization attributes      │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Step 5: STALENESS CHECK                                     │
│  Query CMDB for discovery_source=vCenterETL CIs             │
│  WHERE sys_updated_on < (now - staleness_days)              │
│  Set install_status=7 (Retired) on stale CIs                │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  Step 6: RELATIONSHIP CLEANUP                                │
│  Delete cmdb_rel_ci where parent or child is retired        │
│  Rebuild all current relationships from staging data         │
└─────────────────────────────────────────────────────────────┘
```

---

## Duplicate Detection & Prevention

### Layer 1: Staging Upsert
The staging loader uses MoRef as the natural key. If a staging row for the same
MoRef already exists (from a previous run that wasn't fully processed), it is
updated rather than inserted. This prevents duplicate staging entries.

### Layer 2: IRE Identification
The IRE uses multi-tier identifier matching:
- ESXi hosts: BIOS UUID → MoRef → FQDN
- VMs: Instance UUID → BIOS UUID → MoRef
- Others: MoRef → Name

If any identifier matches an existing CI, the IRE updates that CI rather than
creating a new one.

### Layer 3: Transform Map Coalesce
Each Transform Map has `correlation_id` set as the coalesce field. This provides
a third layer of duplicate prevention if the IRE is not configured.

### Layer 4: Duplicate Detection Script

Run this script to detect potential duplicates:

```javascript
// Detect duplicate ESXi hosts by BIOS UUID
var dup = new GlideAggregate('cmdb_ci_esx_server');
dup.addQuery('discovery_source', 'vCenterETL');
dup.addQuery('u_bios_uuid', '!=', '');
dup.addAggregate('COUNT');
dup.groupBy('u_bios_uuid');
dup.having('COUNT', '>', '1');
dup.query();

while (dup.next()) {
    gs.warn('Duplicate ESXi BIOS UUID: ' + dup.getValue('u_bios_uuid') +
        ' count=' + dup.getAggregate('COUNT'));
}

// Detect duplicate VMs by instance UUID
var dupVM = new GlideAggregate('cmdb_ci_vmware_instance');
dupVM.addQuery('discovery_source', 'vCenterETL');
dupVM.addQuery('u_instance_uuid', '!=', '');
dupVM.addAggregate('COUNT');
dupVM.groupBy('u_instance_uuid');
dupVM.having('COUNT', '>', '1');
dupVM.query();

while (dupVM.next()) {
    gs.warn('Duplicate VM instance UUID: ' + dupVM.getValue('u_instance_uuid') +
        ' count=' + dupVM.getAggregate('COUNT'));
}
```

---

## Staleness Detection

### Configuration

```
x_ftl_vcenter_etl.staleness_days = 7
```

### Logic

After each successful full run, the staleness manager queries:
```sql
SELECT * FROM <cmdb_table>
WHERE discovery_source = 'vCenterETL'
AND install_status != '7'
AND sys_updated_on < NOW() - INTERVAL 7 DAY
```

CIs matching this query were not updated in the current run and are presumed
to have been removed from vCenter.

### Retirement Action

```javascript
ci.setValue('install_status',     '7'); // Retired
ci.setValue('operational_status', '6'); // Retired
ci.update();
```

CIs are NOT deleted. They remain in the CMDB with retired status, preserving
historical relationships and audit trails.

### Restoration Logic

If a retired CI reappears in a subsequent run (e.g., a VM powered back on
or reconfigured), the IRE matches it via UUID and the orchestrator calls:
```javascript
stalenessMgr.restoreCI(table, sysId);
// Sets install_status=1, operational_status=1
```

---

## Partial Payload Tolerance

The integration handles partial/incomplete API responses:

1. **Missing identifier:** If a CI has no valid identifier (no MoRef, no UUID,
   no name), the staging row is skipped with `stg_state=skipped`.

2. **Missing attribute:** Non-critical fields default to empty string. The
   `VCenterUtils.isEmpty()` helper guards all field mappings.

3. **API page failure:** If a paginated request fails mid-way, partial results
   are staged. The next run will fetch complete data and update.

4. **Transform error:** Individual CI transform errors are caught, logged, and
   the staging row marked `stg_state=error`. The pipeline continues to the
   next record. Error rows can be re-queued via:
   ```javascript
   // Re-queue error rows for next run
   var gr = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
   gr.addQuery('stg_state', 'error');
   gr.setValue('stg_state', 'ready');
   gr.updateMultiple();
   ```

---

## Missing Attribute Handling

| Scenario | Handling |
|---|---|
| `bios_uuid` is empty for ESXi host | Fall back to `moref` as identifier |
| `instance_uuid` is empty for VM | Use `bios_uuid`, then `moref` |
| `power_state` is null | Default to `POWERED_OFF` → operational_status=2 |
| `memory_size_MiB` is 0 | Store 0, do not fail |
| `cluster_ref` missing for host | Host is standalone — skip cluster→host rel |
| `dvs_uuid` empty for DVS | Fall back to `moref` as identifier |

---

## Multi-Source Conflict Resolution

If ServiceNow Discovery also manages some of these hosts/VMs, attribute conflicts
are resolved by IRE reconciliation priority:

```
Priority 1: ServiceNow Discovery  (hardware truth — serial, model)
Priority 2: vCenterETL            (virtualisation truth — moref, power state)
Priority 3: Manual entry          (user overrides — rarely authoritative)
```

Fields exclusively owned by vCenterETL (no other source writes them):
- `correlation_id`
- `u_moref`
- `u_instance_uuid`
- `u_bios_uuid` (for VMs — Discovery may also write this for physical hosts)
- `u_dvs_uuid`
- `u_ha_enabled` / `u_drs_enabled`
- `hardware_version`

---

## Data Quality Reporting

### ETL Run Dashboard Metrics

Create a Performance Analytics dashboard or simple list view showing:

**Per-Run Metrics (from x_ftl_vcenter_etl_run.stats_json):**
- Objects staged (per type)
- Objects transformed (per type)
- IRE matches vs. new creates
- Relationships created
- CIs retired

**CMDB Quality Metrics (live):**
- % of vCenterETL VMs with `u_instance_uuid` populated
- % of vCenterETL Hosts with `u_bios_uuid` populated
- Count of vCenterETL CIs in Retired state
- Age of most recent staleness check

**Sample Report Script:**
```javascript
var report = {
    vm_total:          0,
    vm_with_uuid:      0,
    host_total:        0,
    host_with_bios:    0,
    retired:           0
};

var vms = new GlideRecord('cmdb_ci_vmware_instance');
vms.addQuery('discovery_source', 'vCenterETL');
vms.query();
while (vms.next()) {
    report.vm_total++;
    if (vms.getValue('u_instance_uuid')) report.vm_with_uuid++;
    if (vms.getValue('install_status') === '7') report.retired++;
}

var hosts = new GlideRecord('cmdb_ci_esx_server');
hosts.addQuery('discovery_source', 'vCenterETL');
hosts.query();
while (hosts.next()) {
    report.host_total++;
    if (hosts.getValue('u_bios_uuid')) report.host_with_bios++;
}

report.vm_uuid_pct  = report.vm_total   > 0 ?
    Math.round(report.vm_with_uuid / report.vm_total * 100) + '%' : 'N/A';
report.host_bios_pct = report.host_total > 0 ?
    Math.round(report.host_with_bios / report.host_total * 100) + '%' : 'N/A';

gs.info('Data Quality Report: ' + JSON.stringify(report, null, 2));
```
