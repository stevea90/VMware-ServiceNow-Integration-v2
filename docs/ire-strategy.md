# IRE Strategy: Identification & Reconciliation Engine

## Overview

The Identification & Reconciliation Engine (IRE) is the core mechanism that
prevents duplicate CI creation and ensures authoritative attribute ownership
across multiple discovery sources.

This document defines the IRE configuration strategy for all 8 vCenter CI types.

---

## IRE Concepts

| Term | Meaning |
|---|---|
| **Identification Rule** | Set of fields used to find/match an existing CI |
| **Reconciliation Rule** | Controls which source's value "wins" for each field |
| **Identifier** | A field or combination of fields that uniquely identify a CI |
| **Discovery Source** | Source label stamped on each CI write (`discovery_source`) |
| **Precedence** | Rank ordering of discovery sources for conflict resolution |

---

## Identification Rules per CI Type

### 1. cmdb_ci_vcenter

**Table:** `cmdb_ci_vcenter`

```
Rule Name: vCenter ETL - vCenter Instance Identifier
Priority: 1

Identifier Set 1 (strongest):
  Field: u_instance_uuid
  Lookup: Exact match

Identifier Set 2 (fallback):
  Field: correlation_id
  Lookup: Exact match

Identifier Set 3 (last resort):
  Field: name
  Lookup: Exact match
```

**Rationale:** `instance_uuid` is permanently assigned by vCenter at installation
and does not change on upgrade. It is globally unique.

---

### 2. cmdb_ci_datacenter

```
Rule Name: vCenter ETL - Datacenter Identifier
Priority: 1

Identifier Set 1:
  Field: correlation_id   (= vCenter MoRef, e.g. "datacenter-2")
  Lookup: Exact match

Identifier Set 2:
  Field: name
  Lookup: Exact match
```

**Rationale:** MoRefs are stable for the life of the datacenter object within
a vCenter. Name is used as fallback since datacenters rarely share names in
a single vCenter.

---

### 3. cmdb_ci_cluster

```
Rule Name: vCenter ETL - Cluster Identifier
Priority: 1

Identifier Set 1:
  Field: correlation_id   (= vCenter MoRef, e.g. "domain-c8")
  Lookup: Exact match

Identifier Set 2:
  Field: name
  Lookup: Exact match
```

---

### 4. cmdb_ci_esx_server

```
Rule Name: vCenter ETL - ESXi Host Identifier
Priority: 1

Identifier Set 1 (strongest — hardware UUID):
  Field: u_bios_uuid
  Lookup: Exact match
  Note: BIOS UUID survives vCenter migration but NOT hardware replacement

Identifier Set 2:
  Field: correlation_id   (= vCenter host MoRef, e.g. "host-14")
  Lookup: Exact match

Identifier Set 3:
  Fields: name (FQDN)
  Lookup: Exact match
```

**BIOS UUID Caveat:** Some hypervisors or hardware vendors generate identical
BIOS UUIDs on cloned hardware. Add a validation check in VCenterIREPayloadBuilder
to detect and log suspect UUIDs (e.g. all zeros, known bad patterns).

---

### 5. cmdb_ci_vmware_instance

```
Rule Name: vCenter ETL - VM Identifier
Priority: 1

Identifier Set 1 (strongest):
  Field: u_instance_uuid
  Note: Globally unique; survives vMotion, storage vMotion, clone templates
        if properly seeded

Identifier Set 2:
  Field: u_bios_uuid
  Note: Survives vMotion; NOT unique if VM was cloned from template without
        UUID regeneration — handle with duplicate detection

Identifier Set 3:
  Field: correlation_id   (= VM MoRef, e.g. "vm-100")
  Note: Stable within a vCenter but changes on migration to new vCenter
```

**Clone Detection:** When a new VM appears with the same `u_bios_uuid` as an
existing powered-off VM, the IRE will match to the existing CI. If this is
a clone scenario (both VMs active), use `instance_uuid` as primary identifier
and `bios_uuid` only as secondary.

---

### 6. cmdb_ci_datastore

```
Rule Name: vCenter ETL - Datastore Identifier
Priority: 1

Identifier Set 1:
  Field: correlation_id   (= datastore MoRef)
  Lookup: Exact match

Identifier Set 2:
  Field: name
  Lookup: Exact match
```

---

### 7. cmdb_ci_storage_pool

```
Rule Name: vCenter ETL - Storage Pod Identifier
Priority: 1

Identifier Set 1:
  Field: correlation_id   (= storage pod MoRef)
  Lookup: Exact match

Identifier Set 2:
  Field: name
  Lookup: Exact match
```

---

### 8. cmdb_ci_dvs_switch

```
Rule Name: vCenter ETL - DVS Identifier
Priority: 1

Identifier Set 1:
  Field: u_dvs_uuid
  Note: UUID assigned at DVS creation; globally unique

Identifier Set 2:
  Field: correlation_id   (= network MoRef)
  Lookup: Exact match

Identifier Set 3:
  Field: name
  Lookup: Exact match
```

---

## Reconciliation Rules

### Reconciliation Source Priority

```
Priority 1 (highest):  ServiceNow Discovery (if deployed alongside)
Priority 2:            vCenterETL
Priority 3:            Manual entry
```

If ServiceNow Discovery also runs against these ESXi hosts/VMs, Discovery
should take priority for hardware-level attributes (serial number, model),
while vCenterETL owns virtualization-specific attributes (MoRef, vCenter
version, HA/DRS settings).

### Attribute Ownership Matrix

| Attribute | Owner | Rationale |
|---|---|---|
| `name` | vCenterETL | VM names managed in vCenter |
| `correlation_id` | vCenterETL | MoRef is ETL-specific |
| `u_instance_uuid` | vCenterETL | Only vCenter knows this |
| `u_bios_uuid` | vCenterETL | vCenter owns BIOS UUID for VMs |
| `operational_status` | vCenterETL | Power state from vCenter |
| `model_id` / `manufacturer` | Discovery (if active), else vCenterETL | Hardware truth |
| `serial_number` | Discovery (if active) | Only hardware discovery has this |
| `ip_address` | IPAM / Discovery | Network management tools |
| `os` / `os_version` | Discovery (if active), else vCenterETL | Guest OS from vCenter API |
| `ram` / `cpu_count` | vCenterETL | vCenter has allocated values |
| `disk_space` | vCenterETL | Datastore capacity from vCenter |

---

## IRE Configuration in ServiceNow

### Step 1: Enable IRE for Custom Tables

In ServiceNow Studio, for each target CMDB class, ensure:
1. `sys_cmdb_class` record exists
2. Identification rules are configured via **CMDB > Identification/Reconciliation**
3. `discovery_source` field is populated on every CI write

### Step 2: Create Identification Rules

Navigate to: **Configuration > CMDB Identification and Reconciliation >
Identification Rules**

For `cmdb_ci_esx_server`:
```
Name:      vCenter ETL ESXi Host - BIOS UUID
CI Class:  ESX Server [cmdb_ci_esx_server]
Priority:  1
Active:    true

Identifiers:
  Type: Independent
  Attributes:
    - Attribute: u_bios_uuid
      Transform: none
      Case Sensitive: false
```

### Step 3: Configure Reconciliation Rules

Navigate to: **Configuration > CMDB Identification and Reconciliation >
Reconciliation Rules**

```
Name:            vCenterETL Default Reconciliation
Discovery Source: vCenterETL
Priority:         2

Attribute Rules:
  - All attributes: Overwrite if source priority >= current
```

### Step 4: Set Discovery Source

Ensure every CI write via Script Include includes:
```javascript
gr.setValue('discovery_source', 'vCenterETL');
```

The IRE API call also passes the discovery source:
```javascript
sn_ire.IdentificationEngine.identifyCI('vCenterETL', 'cmdb_ci_esx_server', input);
```

---

## IRE API Usage (sn_ire.IdentificationEngine)

```javascript
// Build input document
var input = new GlideInputDocument('cmdb_ci_esx_server');
input.setValue('name',             'esxi-host-01.corp.example.com');
input.setValue('u_bios_uuid',      '4c4c4544-0056-5810-8051-b9c04f4c5831');
input.setValue('correlation_id',   'host-14');
input.setValue('discovery_source', 'vCenterETL');
input.setValue('operational_status', '1');

// Submit to IRE
var result = sn_ire.IdentificationEngine.identifyCI(
    'vCenterETL',          // discovery source
    'cmdb_ci_esx_server',  // CI class
    input                  // field values
);

// Get resolved CI
var ciGr = result.getIdentifiedCI();
var sysId = ciGr.getUniqueValue();
```

---

## Duplicate Prevention

The IRE handles duplicate prevention automatically when identification rules
are correctly configured. Additional safeguards:

1. **MoRef uniqueness:** Each staging table uses MoRef as the natural key for
   upsert operations — no duplicate staging rows per MoRef per run.

2. **Coalesce in Transform Map:** Set `correlation_id` as coalesce field in
   each Transform Map configuration to prevent duplicate CI creation.

3. **Staleness detection:** CIs not seen in current run are retired, not deleted.
   If they reappear in a future run, the IRE matches them via UUID and restores.

4. **Clone detection:** `instance_uuid` is the strongest identifier for VMs.
   Cloned VMs with the same `bios_uuid` but different `instance_uuid` will be
   correctly identified as separate CIs.

---

## IRE Payload for Bulk REST API

For large environments, use the IRE REST API for bulk submission:

```
POST /api/now/identificationengine

{
  "items": [
    {
      "className": "cmdb_ci_esx_server",
      "values": {
        "name":             "esxi-host-01.corp.example.com",
        "u_bios_uuid":      "4c4c4544-0056-5810-8051-b9c04f4c5831",
        "correlation_id":   "host-14",
        "discovery_source": "vCenterETL",
        "operational_status": "1"
      },
      "identifiers": [
        { "className": "cmdb_ci_esx_server", "field": "u_bios_uuid",
          "value": "4c4c4544-0056-5810-8051-b9c04f4c5831" }
      ]
    }
  ],
  "relations": []
}
```

Response:
```json
{
  "result": [
    {
      "className": "cmdb_ci_esx_server",
      "sysId": "abc123...",
      "identifierEntrySysId": "def456...",
      "operation": "INSERT",
      "errors": []
    }
  ]
}
```
