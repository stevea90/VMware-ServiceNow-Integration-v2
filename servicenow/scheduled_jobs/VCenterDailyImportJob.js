/**
 * Scheduled Job: VCenter Daily Import
 * Scope: x_ftl_vcenter_etl
 *
 * Configuration in ServiceNow:
 *   Name:        vCenter CMDB Daily Import
 *   Table:       sysauto_script (Script - Background)
 *   Run:         Daily
 *   Time:        00:00 (midnight, server time)
 *   Run As:      vCenterETL Integration User (dedicated service account)
 *   Active:      true
 *   Conditional: Script below also enforces 00:00–02:00 window
 *
 * The job is idempotent — a second run within the window will detect a
 * currently-running run record and abort gracefully.
 */

(function runVCenterETL() {

    var logger = new x_ftl_vcenter_etl.VCenterLogger('DailyImportJob');

    // ── Time window enforcement (00:00–02:00 server time) ────────────────────
    var now    = new GlideDateTime();
    var hour   = parseInt(now.getLocalTime().getByFormat('HH'));
    if (hour < 0 || hour >= 2) {
        logger.warn('ETL job triggered outside allowed window (00:00–02:00). ' +
            'Current hour: ' + hour + '. Aborting.');
        return;
    }

    // ── Prevent concurrent runs ───────────────────────────────────────────────
    var runCheck = new GlideRecord('x_ftl_vcenter_etl_run');
    runCheck.addQuery('status', 'running');
    // Only flag as concurrent if started within the last 2 hours
    var twoHoursAgo = new GlideDateTime();
    twoHoursAgo.addSeconds(-7200);
    runCheck.addQuery('started_at', '>=', twoHoursAgo.getValue());
    runCheck.setLimit(1);
    runCheck.query();

    if (runCheck.next()) {
        logger.warn('Another ETL run is already in progress (run_id: ' +
            runCheck.getValue('run_id') + '). Aborting duplicate execution.');
        return;
    }

    // ── Execute ETL pipeline ─────────────────────────────────────────────────
    logger.info('Starting scheduled vCenter ETL run');

    try {
        var orchestrator = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
        var summary      = orchestrator.run();

        logger.info('ETL run complete. RunID=' + summary.runId +
            ' Status=' + summary.status +
            ' Duration=' + summary.duration);

        // Write result to ECC queue for MID server monitoring if needed
        var ecc = new GlideRecord('ecc_queue');
        ecc.initialize();
        ecc.setValue('agent',   'mid.server');
        ecc.setValue('topic',   'VCenterETL');
        ecc.setValue('name',    'run_complete');
        ecc.setValue('payload', JSON.stringify({
            run_id:   summary.runId,
            status:   summary.status,
            duration: summary.duration
        }));
        ecc.insert();

    } catch (e) {
        logger.error('Unhandled exception in scheduled job: ' + e.message);
    }

})();
