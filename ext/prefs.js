// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MuslimtifyPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Prayer Times Panel for Muslimtify'});

        const shift = new Adw.SpinRow({
            title: 'Shift window (minutes)',
            subtitle: 'After a prayer starts, show time elapsed for this long, then switch to the next prayer',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 180, step_increment: 1, page_increment: 5}),
        });
        settings.bind('shift-minutes', shift, 'value', Gio.SettingsBindFlags.DEFAULT);

        const cmd = new Adw.EntryRow({title: 'muslimtify command'});
        settings.bind('muslimtify-command', cmd, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Row with a color button that stores its choice in GSettings as "#rrggbb".
        const colorRow = (title, key) => {
            const row = new Adw.ActionRow({title});
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string(key)))   // invalid stored value: show the default
                rgba.parse(settings.get_default_value(key).get_string()[0]);
            const btn = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                rgba,
                valign: Gtk.Align.CENTER,
            });
            btn.connect('notify::rgba', () => {
                const c = btn.get_rgba();
                // RGBA channels are floats in 0..1; convert to a two-digit hex byte.
                const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
                settings.set_string(key, `#${h(c.red)}${h(c.green)}${h(c.blue)}`);
            });
            row.add_suffix(btn);
            return row;
        };

        group.add(shift);
        group.add(colorRow('Current prayer (Now) color', 'current-color'));
        group.add(colorRow('Next prayer color', 'next-color'));
        group.add(cmd);
        page.add(group);
        window.add(page);
    }
}
