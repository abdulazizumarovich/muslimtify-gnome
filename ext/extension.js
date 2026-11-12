// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Gio.Subprocess exposes callback-style async methods; promisify so they can be awaited.
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];   // in chronological order
const OFFSETS = [-1, 0, 1];          // day offsets fetched: yesterday, today, tomorrow
const CONFIG_FILE = 'config.json';   // the CLI's config, inside ~/.config/muslimtify/
const CONFIG_DEBOUNCE_MS = 500;      // coalesce bursts of file events into one refetch
const TICK_SECONDS = 15;             // how often the label is recomputed from cached data
const FETCH_TIMEOUT_SECONDS = 10;    // kill the CLI if it hangs longer than this
const RETRY_MS = 60 * 1000;   // minimum gap between automatic refetch attempts
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ROUND_UP_MS = 59 * 1000;   // remaining time rounds up like a clock
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;   // only accept #rrggbb, since the value goes into a CSS style string

const fmt = ms => {   // relative duration: "1h 21m", "2h", "5m"
    const m = Math.floor(ms / MIN), h = Math.floor(m / 60), r = m % 60;
    return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};

// Local midnight of the given date; used to detect when the day has changed.
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// `muslimtify show --json` -> {Fajr: "04:48", ...} (display names, "HH:MM" strings)
function parseTimes(out) {
    const prayers = JSON.parse(out).prayers ?? {};
    const times = {};
    for (const name of PRAYERS)
        if (prayers[name.toLowerCase()]?.time)
            times[name] = prayers[name.toLowerCase()].time;
    return Object.keys(times).length ? times : null;
}

// Current (last started) and next prayer from {-1: yesterday, 0: today, 1: tomorrow} times.
// Either may be undefined when the surrounding days are unavailable.
function getState(days, now = new Date()) {
    // Flatten all days into one timeline of prayer-start events (d is the day offset;
    // Date normalises overflowing day-of-month values, so now.getDate() + d is safe).
    const events = [];
    for (const d of OFFSETS) {
        const times = days[d];
        if (!times) continue;
        for (const name of PRAYERS) {
            if (!times[name]) continue;
            const [h, m] = times[name].split(':').map(Number);
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m, 0);
            events.push({start, name, text: times[name], day: d});
        }
    }
    events.sort((a, b) => a.start - b.start);
    const past = events.filter(e => e.start <= now);
    const future = events.filter(e => e.start > now);
    const current = past[past.length - 1];
    const next = future[0];
    return {
        current,
        next,
        elapsed: current ? now - current.start : 0,
        remaining: next ? next.start - now + ROUND_UP_MS : 0,
    };
}

function buildLabel(st, shiftMin) {
    // Within the shift window after a prayer starts: show elapsed time ("+12m").
    if (st.current && st.elapsed < shiftMin * MIN)
        return `${st.current.name} ${st.current.text}  |  +${fmt(st.elapsed)}`;
    if (st.next)
        return `${st.next.name} ${st.next.text}  |  ${fmt(st.remaining)}`;
    return 'Prayer --:--';
}

// Returns [{text, color}] lines, one per prayer, on a fixed column grid (name 8, time 7).
function buildDetails(days, st, colors) {
    const times = days[0];
    if (!times) return [];
    const line = (name, time, note) => `${name.padEnd(8)}${time.padEnd(7)}${note}`.trimEnd();
    const lines = [];
    for (const p of PRAYERS.filter(p => times[p])) {
        const t = times[p];
        // Match on name AND day so yesterday's Isha / tomorrow's Fajr never light up today's row.
        if (st.current?.day === 0 && p === st.current.name)
            lines.push({text: line(p, t, `${fmt(st.elapsed)} passed`), color: colors.current});
        else if (st.next?.day === 0 && p === st.next.name)
            lines.push({text: line(p, t, `in ${fmt(st.remaining)}`), color: colors.next});
        else
            lines.push({text: line(p, t, ''), color: null});
    }
    return lines;
}

const Indicator = GObject.registerClass(
class MuslimtifyIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Muslimtify', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._days = {};             // cached times keyed by day offset: {-1: {...}, 0: {...}, 1: {...}}
        this._daysFor = null;        // midnight Date that _days[0] belongs to
        this._fetching = false;      // a fetch is in flight
        this._refetchQueued = false; // another fetch was requested while one was in flight
        this._needsRefetch = false;  // the date rolled over, so cached data is stale
        this._resetNext = false;     // next fetch must discard cached data (command/config changed)
        this._rows = [];             // popup St.Label rows, reused between ticks
        this._lastAttempt = 0;       // timestamp of the last fetch, for RETRY_MS throttling
        this._cancellable = new Gio.Cancellable();

        // Top bar label; the popup menu below lists today's prayers plus Refresh/Settings.
        this._label = new St.Label({
            text: 'Prayer …',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._listItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._details = new St.BoxLayout({vertical: true});
        this._listItem.add_child(this._details);
        this.menu.addMenuItem(this._listItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this._fetch());
        this.menu.addMenuItem(refresh);
        const prefs = new PopupMenu.PopupMenuItem('Settings');
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);

        // Only the command affects what is fetched; everything else is display-only.
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'muslimtify-command') this._fetch(true);
            else this._tick();
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._watchConfig();
        this._fetch();
    }

    // reset: discard cached data first, since it came from a different command/config.
    async _fetch(reset = false) {
        if (reset) this._resetNext = true;
        if (this._fetching) {   // coalesce overlapping requests into one follow-up fetch
            this._refetchQueued = true;
            return;
        }
        this._fetching = true;
        this._lastAttempt = Date.now();
        try {
            await this._doFetch();
        } finally {
            this._fetching = false;
        }
        if (this._settings && this._refetchQueued) {
            this._refetchQueued = false;
            this._fetch();
        }
    }

    async _doFetch() {
        const cmd = this._settings.get_string('muslimtify-command') || 'muslimtify';
        const reset = this._resetNext;
        this._resetNext = false;
        if (reset) this._days = {};
        // Settle the date before awaiting, so the cache is interpreted against the right day.
        this._rollover();
        this._needsRefetch = false;
        const today = this._daysFor ?? startOfDay(new Date());
        // Run the CLI for one day offset and parse its JSON output.
        const load = async offset => {
            const proc = Gio.Subprocess.new([cmd, 'show', '--day-offset', String(offset), '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            let timedOut = false;
            let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FETCH_TIMEOUT_SECONDS, () => {
                timeout = 0;   // source auto-removes on return; don't remove it again below
                timedOut = true;
                proc.force_exit();   // hung CLI: communicate resolves with empty output
                return GLib.SOURCE_REMOVE;
            });
            try {
                const [out] = await proc.communicate_utf8_async(null, this._cancellable);
                if (timedOut) throw new Error(`'${cmd}' timed out after ${FETCH_TIMEOUT_SECONDS}s`);
                return parseTimes(out);
            } catch (e) {
                proc.force_exit();
                throw e;
            } finally {
                if (timeout) GLib.source_remove(timeout);
            }
        };
        // allSettled: one failing day must not discard the others.
        const results = await Promise.allSettled(OFFSETS.map(load));
        if (!this._settings) return;   // destroyed while waiting

        // Keep cached same-day data across failed refetches (already shifted/reset above).
        const fresh = this._daysFor?.getTime() === today.getTime() ? {...this._days} : {};
        results.forEach((r, i) => {
            const off = OFFSETS[i];
            if (r.status === 'fulfilled' && r.value) fresh[off] = r.value;
            else if (r.status === 'rejected' && !r.reason?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(r.reason, 'muslimtify');
        });
        this._days = fresh;
        this._daysFor = today;
        this._tick();
    }

    // Shift cached days when the date has changed since they were fetched, so stale
    // entries are never interpreted relative to the wrong date.
    _rollover() {
        if (!this._daysFor) return;
        const today = startOfDay(new Date());
        const shift = Math.round((today - this._daysFor) / DAY);
        if (shift === 0) return;
        const shifted = {};
        for (const off of OFFSETS)
            if (this._days[off + shift]) shifted[off] = this._days[off + shift];
        this._days = shifted;
        this._daysFor = today;
        this._needsRefetch = true;
    }

    // Watch the CLI's config directory (not the file) so atomic saves (write temp + rename),
    // delete + recreate, and first-time creation are all seen. Changes are debounced into one fetch.
    _watchConfig() {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'muslimtify']);
        const dir = Gio.File.new_for_path(path);
        try {
            // A directory monitor needs the directory to exist to see its first-time creation.
            GLib.mkdir_with_parents(path, 0o755);
            this._configMonitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            logError(e, 'muslimtify');
            return;
        }
        const isConfig = f => f?.get_basename() === CONFIG_FILE;
        this._monitorId = this._configMonitor.connect('changed', (_m, file, other, event) => {
            const E = Gio.FileMonitorEvent;
            const relevant = [E.CHANGES_DONE_HINT, E.CREATED, E.DELETED, E.MOVED_IN, E.MOVED_OUT, E.RENAMED]
                .includes(event);
            if (!relevant || !(isConfig(file) || isConfig(other))) return;
            if (this._debounce) GLib.source_remove(this._debounce);
            this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIG_DEBOUNCE_MS, () => {
                this._debounce = null;
                this._fetch(true);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _tick() {
        if (!this._settings) return;
        this._rollover();
        // Refetch when the date changed or any day's data is missing, throttled to one try per RETRY_MS.
        if ((this._needsRefetch || OFFSETS.some(o => !this._days[o])) && !this._fetching &&
            Date.now() - this._lastAttempt >= RETRY_MS) {
            this._needsRefetch = false;
            this._fetch();
        }
        // Read a color setting, falling back if it isn't a valid #rrggbb value.
        const color = (key, fallback) => {
            const c = this._settings.get_string(key);
            return COLOR_RE.test(c) ? c : fallback;
        };
        const st = getState(this._days);
        this._label.set_text(buildLabel(st, this._settings.get_int('shift-minutes')));
        const rows = buildDetails(this._days, st, {
            current: color('current-color', '#57e389'),
            next: color('next-color', '#ffa348'),
        });
        // Reuse the row actors; only rebuild when the number of rows changes.
        if (rows.length !== this._rows.length) {
            this._details.destroy_all_children();
            this._rows = rows.map(() => {
                const l = new St.Label();
                this._details.add_child(l);
                return l;
            });
        }
        rows.forEach(({text, color: c}, i) => {
            this._rows[i].set_text(text);
            this._rows[i].set_style(`font-family: monospace; font-size: 11pt;${c ? ` color: ${c};` : ''}`);
        });
    }

    // Release everything the shell would otherwise keep alive: timer, in-flight fetches, signal.
    destroy() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        if (this._debounce) GLib.source_remove(this._debounce);
        this._debounce = null;
        if (this._monitorId) this._configMonitor.disconnect(this._monitorId);
        this._configMonitor?.cancel();
        this._configMonitor = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._settings.disconnect(this._settingsId);
        this._settings = null;
        super.destroy();
    }
});

export default class MuslimtifyExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
