/**
 * Script Include: VCenterRetryHandler
 * Scope: x_ftl_vcenter_etl
 *
 * Provides exponential-backoff retry logic for REST calls and other
 * transient-failure operations.
 */
var VCenterRetryHandler = Class.create();
VCenterRetryHandler.prototype = {

    initialize: function() {
        this.logger = new VCenterLogger('VCenterRetryHandler');
    },

    /**
     * Execute fn with retries.
     *
     * @param {Function} fn          - Zero-arg function to attempt.
     * @param {number}   maxAttempts - Max total attempts (default 3).
     * @param {number}   baseDelayMs - Base backoff in ms (default 2000).
     * @returns {*} fn return value, or null after all attempts exhausted.
     */
    execute: function(fn, maxAttempts, baseDelayMs) {
        maxAttempts = maxAttempts || 3;
        baseDelayMs = baseDelayMs || 2000;

        var attempt = 0;
        while (attempt < maxAttempts) {
            attempt++;
            try {
                var result = fn();
                if (result !== null && result !== undefined) {
                    if (result.status && this._isRetryable(result.status)) {
                        this.logger.warn('Retryable HTTP status ' + result.status +
                            ' on attempt ' + attempt + '/' + maxAttempts);
                    } else {
                        return result;
                    }
                } else {
                    return result;
                }
            } catch (e) {
                this.logger.warn('Exception on attempt ' + attempt + '/' + maxAttempts +
                    ': ' + e.message);
            }

            if (attempt < maxAttempts) {
                var delay = baseDelayMs * Math.pow(2, attempt - 1);
                this.logger.info('Backing off ' + delay + 'ms before retry ' + (attempt + 1));
                gs.sleep(delay);
            }
        }

        this.logger.error('All ' + maxAttempts + ' attempts exhausted.');
        return null;
    },

    /** HTTP status codes worth retrying */
    _isRetryable: function(status) {
        return [429, 500, 502, 503, 504].indexOf(parseInt(status)) >= 0;
    },

    type: 'VCenterRetryHandler'
};
