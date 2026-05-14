# Update Set & App Repo Deployment Guide

## Overview

This integration can be deployed via three methods:

| Method | Best For | Pros | Cons |
|---|---|---|---|
| Update Set | Org without App Repo | Simple, familiar process | Manual per-instance |
| Application Repository | Enterprise multi-instance | Versioned, centralised | Requires App Repo setup |
| Source Control (Git) | CI/CD pipelines | Automated, diff-tracked | Requires Studio Git config |

---

## Method 1: Update Set Deployment

### Step 1: Create the Update Set (on Source Instance)

1. Navigate to: **System Update Sets > Local Update Sets > New**
   ```
   Name:        vCenter CMDB ETL v1.0.0
   Application: vCenter CMDB ETL (FT1) [x_ftl_vcenter_etl]
   Description: Initial deployment of VMware vCenter CMDB integration
   State:       In Progress
   ```
2. Click **Submit**

### Step 2: Set as Current Update Set

Navigate to: **System Update Sets > Local Update Sets**
Find your update set → Click **Make Current**

### Step 3: Capture All Artifacts

Ensure the following are captured (create/modify each in scope):

**Tables (create if not already captured):**
- x_ftl_vcenter_etl_staging_base (+ all fields)
- x_ftl_vcenter_etl_vcenter_stg
- x_ftl_vcenter_etl_datacenter_stg
- x_ftl_vcenter_etl_cluster_stg
- x_ftl_vcenter_etl_host_stg
- x_ftl_vcenter_etl_vm_stg
- x_ftl_vcenter_etl_datastore_stg
- x_ftl_vcenter_etl_ds_cluster_stg
- x_ftl_vcenter_etl_dvs_stg
- x_ftl_vcenter_etl_log
- x_ftl_vcenter_etl_run

**Script Includes:**
- VCenterLogger, VCenterRetryHandler, VCenterUtils, VCenterConfig
- VCenterAPIClient, VCenterStagingLoader, VCenterIREPayloadBuilder
- VCenterRelationshipBuilder, VCenterStalenessManager
- VCenterTransformEngine, VCenterETLOrchestrator

**Transform Maps** (with field maps and scripts):
- vCenter ETL - vCenter Instance
- vCenter ETL - Datacenter
- vCenter ETL - Cluster
- vCenter ETL - ESXi Host
- vCenter ETL - Virtual Machine
- vCenter ETL - Datastore
- vCenter ETL - Datastore Cluster
- vCenter ETL - Distributed Switch

**Scheduled Jobs:**
- vCenter CMDB Daily Import

**Business Rules:**
- vCenter ETL - CI Retirement Cascade

**System Properties** (all x_ftl_vcenter_etl.* properties)

**Connection Alias definition:**
- x_ftl_vcenter_etl.vcenter_conn

**Roles:**
- x_ftl_vcenter_etl.etl_admin
- x_ftl_vcenter_etl.etl_user

### Step 4: Complete the Update Set

1. Navigate to the Update Set record
2. Click **Complete**
3. State changes to **Complete**

### Step 5: Export the Update Set

1. Navigate to: **System Update Sets > Local Update Sets**
2. Open the completed Update Set
3. Click **Export to XML**
4. Save the `.xml` file

### Step 6: Import on Target Instance

1. Navigate to: **System Update Sets > Retrieved Update Sets > Import Update Set from XML**
2. Upload the `.xml` file
3. Click **Upload**

### Step 7: Preview the Update Set

1. Open the imported update set
2. Click **Preview Update Set**
3. Review for conflicts
4. Resolve any conflicts (typically "Skip Remote Update" for local customisations)

### Step 8: Commit the Update Set

1. Click **Commit Update Set**
2. Monitor for errors
3. Validate on target instance

---

## Method 2: Application Repository

### Prerequisites

- ServiceNow Application Repository configured (Hi Portal: SNC Application Repo)
- Publisher account with x_ftl prefix authorised

### Step 1: Publish to App Repo

In Studio on source instance:
1. **File > Publish to Update Set** — NOT used for App Repo
2. Instead: **File > Submit to App Repository**
   ```
   Version:      1.0.0
   Release Notes: Initial production release
   Category:     Integration
   Visibility:   Internal
   ```
3. Click **Submit**

### Step 2: Install from App Repo on Target

1. Navigate to: **System Applications > All Available Applications > All**
2. Search: `vCenter CMDB ETL`
3. Click **Install**

---

## Method 3: Source Control (Git)

### Prerequisites

- Git repository (this repo: `stevea90/vmware-servicenow-integration-v2`)
- ServiceNow Studio Git integration configured
- Personal Access Token for GitHub

### Step 1: Link Studio to Repository

In ServiceNow Studio:
1. **Source Control > Link to Source Control**
   ```
   URL:      https://github.com/stevea90/vmware-servicenow-integration-v2
   Branch:   claude/vcenter-cmdb-integration-xCHb1
   Username: <github-username>
   Password: <PAT>
   ```
2. Click **Link to Source Control**

### Step 2: Pull Application

Studio will pull all files from the repository into the current scope.

### Step 3: Deploy Changes

After modifying files locally in the repo:
1. Commit and push to the branch
2. In Studio: **Source Control > Apply Remote Changes**

---

## Deployment Sequencing (Multi-Instance)

Recommended deployment order for a typical three-tier environment:

```
DEV (PDI)          → Testing & initial configuration
    ↓ Update Set
UAT / Pre-Prod     → Integration testing with real vCenter (limited)
    ↓ Update Set
Production         → Full deployment
```

### Environment-Specific Configuration

Use sys_properties to vary configuration per environment:

| Property | DEV | UAT | PROD |
|---|---|---|---|
| `vcenter_host` | `mock-server:8080` | `vc-uat.corp.example.com` | `vcenter-ft1.corp.example.com` |
| `log_level` | `DEBUG` | `INFO` | `WARN` |
| `batch_size` | `10` | `50` | `50` |
| `scheduled job active` | `false` | `false` | `true` |

---

## Post-Deployment Validation Checklist

- [ ] All Script Includes visible in Studio with no syntax errors
- [ ] Staging tables accessible and have correct fields
- [ ] CMDB custom fields (u_bios_uuid, u_instance_uuid, etc.) exist
- [ ] IRE identification rules configured for all 8 CI types
- [ ] Connection & Credential Alias resolves (test connection button)
- [ ] MID Server is Up and validated
- [ ] System properties all set to correct values
- [ ] Run configuration validation script:
  ```javascript
  var cfg = new x_ftl_vcenter_etl.VCenterConfig();
  var missing = cfg.validate();
  gs.info('Missing: ' + missing.join(', ') || 'None');
  ```
- [ ] Scheduled job exists and is Active (enable only for PROD)
- [ ] Notification email configured if required
- [ ] Test run executed successfully (see testing-strategy.md)

---

## Versioning Strategy

| Version | Change Type | Description |
|---|---|---|
| 1.0.0 | Initial | Base integration for FT1 domain |
| 1.1.0 | Minor | Add incremental retrieval support |
| 1.2.0 | Minor | Add vCenter tag import |
| 2.0.0 | Major | Multi-vCenter support |

Semantic versioning: `MAJOR.MINOR.PATCH`
- MAJOR: Breaking changes to table schema or API
- MINOR: New features, backward-compatible
- PATCH: Bug fixes
