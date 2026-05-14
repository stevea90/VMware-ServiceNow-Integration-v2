# Flow Designer: vCenter ETL Orchestration Flow

## Overview

This document describes the Flow Designer flow that provides a UI-triggered
alternative to the scheduled job for on-demand ETL execution, status visibility,
and error escalation workflows.

The flows complement the scheduled job — they are NOT a replacement for the
core Script Include pipeline, which is invoked by both the flow and the job.

---

## Flow 1: vCenter ETL - On-Demand Run

**Purpose:** Allow ETL admins to trigger a manual import without waiting for
the scheduled window.

**Flow Type:** Flow  
**Trigger:** Service Catalog Request OR Manual trigger (button)  
**Run As:** System (with elevated privilege set)

### Flow Steps

```
TRIGGER: Manual / Catalog Request
    │
    ├── STEP 1: Log Run Start
    │     Action: Create Record
    │     Table:  x_ftl_vcenter_etl_log
    │     Fields: level=INFO, message='Manual ETL run triggered by: '+trigger.user
    │
    ├── STEP 2: Check for Active Run
    │     Action: Look Up Records
    │     Table:  x_ftl_vcenter_etl_run
    │     Filter: status=running AND started_at >= NOW-2h
    │     Result: Store in 'activeRuns'
    │
    ├── IF STEP: activeRuns.count > 0
    │     THEN: Send notification "ETL already running — run ID: [activeRuns.0.run_id]"
    │           END FLOW
    │
    ├── STEP 3: Run ETL Pipeline
    │     Action: Run Script
    │     Script:
    │       var o = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
    │       fd_data.summary = JSON.stringify(o.run());
    │
    ├── STEP 4: Parse Result
    │     Action: Transform (JSONPath)
    │     Input:  fd_data.summary
    │     Extract: status, runId, duration
    │
    ├── STEP 5: Send Completion Notification
    │     Action: Send Email
    │     To:     trigger.user.email
    │     Subject: vCenter ETL Complete — [status]
    │     Body:   Run ID: [runId], Status: [status], Duration: [duration]
    │
    └── END
```

---

## Flow 2: vCenter ETL - Failure Escalation

**Purpose:** When an ETL run fails, escalate to the integration owner
via email and create an incident if configured.

**Flow Type:** Flow  
**Trigger:** Record Created/Updated on `x_ftl_vcenter_etl_run`  
**Condition:** `status == failed`

### Flow Steps

```
TRIGGER: x_ftl_vcenter_etl_run.status changes to 'failed'
    │
    ├── STEP 1: Lookup Error Logs
    │     Action: Look Up Records
    │     Table:  x_ftl_vcenter_etl_log
    │     Filter: run_id = trigger.run_id AND level = ERROR
    │
    ├── STEP 2: Check Create Incident Property
    │     Action: Get Property
    │     Name:   x_ftl_vcenter_etl.create_incident_on_failure
    │
    ├── IF STEP: property.value == 'true'
    │     THEN:
    │       STEP 3: Create Incident
    │         Action: Create Record
    │         Table:  incident
    │         Fields:
    │           short_description: 'vCenter ETL Failed - RunID: '+trigger.run_id
    │           description:       [error logs joined]
    │           category:          'software'
    │           subcategory:       'integration'
    │           assignment_group:  [x_ftl_vcenter_etl.incident_group property]
    │           priority:          '3' (Moderate)
    │
    ├── STEP 4: Send Failure Email
    │     Action: Send Email
    │     To:     sys_property[x_ftl_vcenter_etl.notify_email]
    │     Subject: [CRITICAL] vCenter ETL FAILED — RunID: [run_id]
    │     Body:   Phase: [current_phase]
    │             vCenter: [vcenter]
    │             Errors: [first 5 ERROR log messages]
    │             Started: [started_at]
    │
    └── END
```

---

## Flow 3: vCenter ETL - CI Retirement Approval

**Purpose:** Before permanently deleting retired CIs (install_status=7 for
>30 days), require manager approval.

**Flow Type:** Approval Flow  
**Trigger:** Scheduled (weekly)

### Flow Steps

```
TRIGGER: Scheduled - Weekly, Friday 18:00
    │
    ├── STEP 1: Find Long-Retired CIs
    │     Action: Look Up Records
    │     Table:  cmdb_ci
    │     Filter: discovery_source=vCenterETL
    │             AND install_status=7
    │             AND sys_updated_on < NOW-30d
    │
    ├── IF STEP: Long-retired CIs found
    │     THEN:
    │       STEP 2: Request Approval
    │         Action: Ask for Approval
    │         From:   CMDB Team
    │         To:     sys_property[x_ftl_vcenter_etl.retirement_approver]
    │         Msg:    "[count] vCenter CIs have been retired for >30 days.
    │                  Approve permanent deletion?"
    │         Due:    +5 business days
    │
    │       IF Approved:
    │         STEP 3: Delete Retired CIs
    │           Action: Delete Record (loop over found records)
    │
    │       IF Rejected:
    │         STEP 4: Log Rejection
    │           Create log record: "CI retirement deletion rejected by [approver]"
    │
    └── END
```

---

## Flow Designer Implementation Notes

### Creating the On-Demand Flow

1. Navigate to: **Process Automation > Flow Designer > New Flow**
2. Name: `vCenter ETL - On-Demand Run`
3. Set Run As: `System`
4. Add trigger: `Service Catalog`
5. Add steps per the diagram above
6. Publish

### Creating a Catalog Item (optional)

To expose the on-demand run as a catalog request:

```
Catalog:      Technical Catalog
Name:         Run vCenter CMDB ETL
Category:     CMDB Management
Short desc:   Manually trigger a vCenter → CMDB ETL sync
Fulfillment:  Link to Flow: vCenter ETL - On-Demand Run
Variables:
  - Reason for manual run (text, optional)
```

### Flow Variables Available

The Flow Designer run script step exposes `fd_data` for passing data between steps:

```javascript
// In Run Script step:
var orchestrator = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
var result       = orchestrator.run();

// Pass to next step:
fd_data.run_id   = result.runId;
fd_data.status   = result.status;
fd_data.duration = result.duration;
```

---

## Additional Properties for Flow Support

Add these properties for flow-related features:

```
x_ftl_vcenter_etl.create_incident_on_failure = false
x_ftl_vcenter_etl.incident_group             = <assignment_group_sys_id>
x_ftl_vcenter_etl.retirement_approver        = <user_sys_id_or_email>
```
