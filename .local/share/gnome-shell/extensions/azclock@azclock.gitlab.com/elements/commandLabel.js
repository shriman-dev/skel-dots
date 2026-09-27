import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Label} from './baseLabel.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const MAX_ERROR_INTERVAL = 300000; // 5 minute max backoff

export const CommandLabel = GObject.registerClass(
class AzClockCommandLabel extends Label {
    _init(settings, extension) {
        super._init(settings, extension);
        this._errorPollingInterval = null;
        this._pollingIntervalId = null;
        this._cancellable = null;

        this._settings.connectObject('changed::command', () => this._refreshCommand(), this);
        this._settings.connectObject('changed::polling-enabled', () => this._refreshCommand(), this);
        this._settings.connectObject('changed::polling-interval', () => this._refreshCommand(), this);
        this._settings.connectObject('changed::hide-on-error', () => this._refreshCommand(), this);
        this._refreshCommand();
    }

    _setErrorState(msg) {
        const hideOnError = this._settings.get_boolean('hide-on-error');
        this.visible = !hideOnError;

        this.text = _(msg);
        this.setMarkup(this.text);
        this._backoffPollingInterval();
    }

    _getBasePollingInterval() {
        const pollingInterval = this._settings.get_int('polling-interval');
        return Math.max(pollingInterval, 250);
    }

    _backoffPollingInterval() {
        if (!this._settings.get_boolean('polling-enabled'))
            return;

        const baseInterval = this._getBasePollingInterval();
        this._errorPollingInterval = this._errorPollingInterval
            ? Math.min(this._errorPollingInterval * 2, MAX_ERROR_INTERVAL)
            : baseInterval * 2;

        this._removePollingInterval();
        this._startPollingInterval();
    }

    _resetPollingInterval() {
        if (!this._errorPollingInterval)
            return;

        this._errorPollingInterval = null;

        if (!this._settings.get_boolean('polling-enabled'))
            return;

        this._removePollingInterval();
        this._startPollingInterval();
    }

    _refreshCommand() {
        this._errorPollingInterval = null;
        this._removePollingInterval();
        this._executeCommand();
        const pollingEnabled = this._settings.get_boolean('polling-enabled');
        if (pollingEnabled)
            this._startPollingInterval();
    }

    _startPollingInterval() {
        const interval = this._errorPollingInterval || this._getBasePollingInterval();
        this._pollingIntervalId = GLib.timeout_add(GLib.PRIORITY_HIGH, interval, () => {
            this._executeCommand();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _removePollingInterval() {
        if (this._pollingIntervalId) {
            GLib.source_remove(this._pollingIntervalId);
            this._pollingIntervalId = null;
        }
    }

    async _executeCommand() {
        const command = this._settings.get_string('command');
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        if (!command || command.length === 0) {
            this._setErrorState(_('Command not set'));
            return;
        }

        try {
            const flags = Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE;

            const proc = Gio.Subprocess.new(['bash', '-c', command], flags);
            const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);

            if (cancellable.is_cancelled())
                return;

            if (!proc.get_successful() || stderr) {
                this._setErrorState(_('Command error'));
                const status = proc.get_exit_status();
                console.log(`Desktop Widgets - Error executing command "${command}": ${stderr ? stderr.trim() : GLib.strerror(status)}`);
                return;
            }

            const response = stdout.trim();

            if (!response) {
                this._setErrorState(_('No output'));
                return;
            }

            if (!this.visible)
                this.visible = true;

            this.text = response;
            this.setMarkup(response);

            // If currently in error state, and now successful,
            // reset the polling interval back to default value.
            if (this._errorPollingInterval)
                this._resetPollingInterval();
        } catch (err) {
            if (err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;

            this._setErrorState(_('Command error'));
            console.log(`Desktop Widgets - Error executing command "${command}": ${err}`);
        }
    }

    _onDestroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._removePollingInterval();
        super._onDestroy();
    }
});
