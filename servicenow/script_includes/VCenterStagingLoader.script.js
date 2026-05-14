/**
 * Script Include: VCenterStagingLoader
 * Scope: x_ftl_vcenter_etl
 *
 * Writes raw vCenter API payloads into the staging tables so that the
 * ETL transform engine can process them independently.
 * Each object type has a dedicated staging table that extends
 * x_ftl_vcenter_etl_staging_base.
 *
 * Staging table map:
 *   vCenter Instance  → x_ftl_vcenter_etl_vcenter_stg
 *   Datacenter        → x_ftl_vcenter_etl_datacenter_stg
 *   Cluster           → x_ftl_vcenter_etl_cluster_stg
 *   ESXi Host         → x_ftl_vcenter_etl_host_stg
 *   Virtual Machine   → x_ftl_vcenter_etl_vm_stg
 *   Datastore         → x_ftl_vcenter_etl_datastore_stg
 *   Datastore Cluster → x_ftl_vcenter_etl_ds_cluster_stg
 *   Distributed VSW   → x_ftl_vcenter_etl_dvs_stg
 */
var VCenterStagingLoader = Class.create();
VCenterStagingLoader.prototype = {

    initialize: function(runId) {
        this.runId  = runId || '';
        this.logger = new VCenterLogger('VCenterStagingLoader', runId);
        this.utils  = new VCenterUtils();
        this.stats  = {};          // { tableName: { inserted, updated, skipped } }
    },

    // ─── Public Load Methods ─────────────────────────────────────────────────

    loadVCenter: function(data) {
        return this._upsert('x_ftl_vcenter_etl_vcenter_stg', 'moref', data, this._mapVCenter);
    },

    loadDatacenter: function(data) {
        return this._upsert('x_ftl_vcenter_etl_datacenter_stg', 'moref', data, this._mapDatacenter);
    },

    loadCluster: function(data) {
        return this._upsert('x_ftl_vcenter_etl_cluster_stg', 'moref', data, this._mapCluster);
    },

    loadHost: function(data) {
        return this._upsert('x_ftl_vcenter_etl_host_stg', 'moref', data, this._mapHost);
    },

    loadVM: function(data) {
        return this._upsert('x_ftl_vcenter_etl_vm_stg', 'moref', data, this._mapVM);
    },

    loadDatastore: function(data) {
        return this._upsert('x_ftl_vcenter_etl_datastore_stg', 'moref', data, this._mapDatastore);
    },

    loadDatastoreCluster: function(data) {
        return this._upsert('x_ftl_vcenter_etl_ds_cluster_stg', 'moref', data, this._mapDatastoreCluster);
    },

    loadDistributedSwitch: function(data) {
        return this._upsert('x_ftl_vcenter_etl_dvs_stg', 'moref', data, this._mapDVS);
    },

    /**
     * Bulk load an array of objects into a staging table.
     * Returns { inserted, updated, skipped } counts.
     */
    bulkLoad: function(type, items) {
        var loaders = {
            vcenter:           this.loadVCenter.bind(this),
            datacenter:        this.loadDatacenter.bind(this),
            cluster:           this.loadCluster.bind(this),
            host:              this.loadHost.bind(this),
            vm:                this.loadVM.bind(this),
            datastore:         this.loadDatastore.bind(this),
            datastore_cluster: this.loadDatastoreCluster.bind(this),
            dvs:               this.loadDistributedSwitch.bind(this)
        };

        var loader = loaders[type];
        if (!loader) {
            this.logger.error('Unknown staging type: ' + type);
            return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        }

        var counts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        for (var i = 0; i < items.length; i++) {
            try {
                var result = loader(items[i]);
                if (result) counts[result]++;
            } catch (e) {
                this.logger.error('Staging error for ' + type + ' item ' + i + ': ' + e.message);
                counts.errors++;
            }
        }

        this.logger.info('Bulk staged ' + type + ': ' + JSON.stringify(counts));
        return counts;
    },

    /** Return accumulated stats across all tables. */
    getStats: function() {
        return this.stats;
    },

    // ─── Generic Upsert ──────────────────────────────────────────────────────

    /**
     * Insert or update a staging record.
     * @param {string}   table       - Staging table name
     * @param {string}   keyField    - Field used as natural key (usually 'moref')
     * @param {object}   raw         - Raw API response object
     * @param {Function} mapperFn    - this._mapXxx mapper
     * @returns {'inserted'|'updated'|'skipped'}
     */
    _upsert: function(table, keyField, raw, mapperFn) {
        var mapped = mapperFn.call(this, raw);
        if (!mapped || !mapped[keyField]) {
            this.logger.warn('Skipping record with no ' + keyField + ' in table ' + table);
            this._track(table, 'skipped');
            return 'skipped';
        }

        // Stamp common fields
        mapped.run_id        = this.runId;
        mapped.raw_payload   = this.utils.truncate(JSON.stringify(raw), 8000);
        mapped.last_seen     = this.utils.now();

        var gr = new GlideRecord(table);
        gr.addQuery(keyField, mapped[keyField]);
        gr.setLimit(1);
        gr.query();

        var action;
        if (gr.next()) {
            // Update existing staging row
            for (var field in mapped) {
                if (mapped.hasOwnProperty(field)) {
                    gr.setValue(field, mapped[field]);
                }
            }
            gr.setValue('stg_state', 'ready');
            gr.update();
            action = 'updated';
        } else {
            // Insert new staging row
            gr.initialize();
            for (var f in mapped) {
                if (mapped.hasOwnProperty(f)) {
                    gr.setValue(f, mapped[f]);
                }
            }
            gr.setValue('stg_state', 'ready');
            gr.insert();
            action = 'inserted';
        }

        this._track(table, action);
        return action;
    },

    // ─── Field Mappers ───────────────────────────────────────────────────────

    _mapVCenter: function(raw) {
        return {
            moref:        raw.vcenter_id   || raw.hostname || '',
            name:         raw.hostname     || raw.name     || '',
            version:      raw.version      || '',
            build:        raw.build        || '',
            instance_uuid: raw.instance_uuid || '',
            api_version:  raw.api_version  || '',
            vcenter_fqdn: raw.hostname     || ''
        };
    },

    _mapDatacenter: function(raw) {
        return {
            moref:        raw.datacenter   || '',
            name:         raw.name         || '',
            vcenter_ref:  raw.vcenter_id   || ''
        };
    },

    _mapCluster: function(raw) {
        return {
            moref:              raw.cluster         || '',
            name:               raw.name            || '',
            datacenter_ref:     raw.datacenter      || '',
            ha_enabled:         String(raw.ha_enabled    || false),
            drs_enabled:        String(raw.drs_enabled   || false),
            num_hosts:          String(raw.resource_pool ? raw.resource_pool.cpu_allocation : 0)
        };
    },

    _mapHost: function(raw) {
        return {
            moref:              raw.host            || '',
            name:               raw.name            || '',
            cluster_ref:        raw.cluster         || '',
            datacenter_ref:     raw.datacenter      || '',
            power_state:        raw.power_state     || '',
            connection_state:   raw.connection_state || '',
            cpu_count:          String(raw.cpu_count  || 0),
            cpu_cores:          String(raw.cpu_cores  || 0),
            memory_size_gb:     String(new VCenterUtils().bytesToGB(raw.memory_size_MiB ? raw.memory_size_MiB * 1024 * 1024 : 0)),
            model:              raw.model           || '',
            vendor:             raw.vendor          || '',
            bios_uuid:          raw.bios_uuid       || '',
            os_type:            raw.os_type         || ''
        };
    },

    _mapVM: function(raw) {
        var utils = new VCenterUtils();
        var memory = raw.memory ? raw.memory.size_MiB : 0;
        return {
            moref:              raw.vm              || '',
            name:               raw.name            || '',
            instance_uuid:      raw.identity ? raw.identity.instance_uuid : '',
            bios_uuid:          raw.identity ? raw.identity.bios_uuid     : '',
            host_ref:           raw.placement ? raw.placement.host         : '',
            cluster_ref:        raw.placement ? raw.placement.cluster      : '',
            resource_pool_ref:  raw.placement ? raw.placement.resource_pool: '',
            datacenter_ref:     raw.placement ? raw.placement.datacenter   : '',
            power_state:        raw.power_state     || '',
            cpu_count:          String(raw.cpu ? raw.cpu.count : 0),
            cpu_cores_per_socket: String(raw.cpu ? raw.cpu.cores_per_socket : 0),
            memory_size_gb:     String(utils.mbToGB(memory)),
            guest_os:           raw.guest_OS        || '',
            guest_hostname:     raw.identity ? raw.identity.name          : '',
            num_disks:          String(raw.disks ? raw.disks.length        : 0),
            num_nics:           String(raw.nics  ? raw.nics.length         : 0),
            hardware_version:   raw.hardware_version || ''
        };
    },

    _mapDatastore: function(raw) {
        var utils = new VCenterUtils();
        return {
            moref:              raw.datastore       || '',
            name:               raw.name            || '',
            type:               raw.type            || '',
            capacity_gb:        String(utils.bytesToGB(raw.capacity || 0)),
            free_space_gb:      String(utils.bytesToGB(raw.free_space || 0)),
            accessible:         String(raw.accessible || false),
            datacenter_ref:     raw.datacenter      || ''
        };
    },

    _mapDatastoreCluster: function(raw) {
        return {
            moref:              raw.storage_pod     || raw.moref || '',
            name:               raw.name            || '',
            sdrs_enabled:       String(raw.sdrs_enabled || false),
            capacity_gb:        String(raw.capacity_gb || 0),
            free_space_gb:      String(raw.free_space_gb || 0),
            datacenter_ref:     raw.datacenter      || ''
        };
    },

    _mapDVS: function(raw) {
        return {
            moref:              raw.distributed_switch || raw.network || '',
            name:               raw.name               || '',
            type:               raw.type               || 'DISTRIBUTED_PORTGROUP',
            dvs_uuid:           raw.dvs_uuid           || '',
            datacenter_ref:     raw.datacenter         || '',
            num_ports:          String(raw.num_ports   || 0),
            uplink_count:       String(raw.uplink_count || 0)
        };
    },

    // ─── Stats Tracking ──────────────────────────────────────────────────────

    _track: function(table, action) {
        if (!this.stats[table]) {
            this.stats[table] = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        }
        this.stats[table][action] = (this.stats[table][action] || 0) + 1;
    },

    type: 'VCenterStagingLoader'
};
