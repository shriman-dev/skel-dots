import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {AboutPage} from './settings/aboutPage.js';
import {DonatePage} from './settings/donatePage.js';
import {DialogWindow} from './settings/dialogWindow.js';
import {WidgetSettingsPage} from './settings/widgetSettingsPage.js';

import * as Utils from './utils.js';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WidgetType = {
    DIGITAL: 0,
    ANALOG: 1,
    TEXT: 2,
    COMMAND: 3,
    WEATHER: 4,
    IMAGE: 5,
    EMPTY: 6,
};

export default class AzClockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const resourcePath = '/org/gnome/shell/extensions/azclock/icons';
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!iconTheme.get_resource_path().includes(resourcePath))
            iconTheme.add_resource_path(resourcePath);

        const resource = Gio.Resource.load(`${this.path}/data/resources.gresource`);
        Gio.resources_register(resource);

        const settings = this.getSettings();

        let pageChangedId = settings.connect('changed::prefs-visible-page', () => {
            if (settings.get_string('prefs-visible-page') !== '')
                this._setVisiblePage(window, settings);
        });
        window.connect('close-request', () => {
            if (pageChangedId) {
                settings.disconnect(pageChangedId);
                pageChangedId = null;
            }
            Gio.resources_unregister(resource);
        });

        window.set_default_size(750, 800);

        const homePage = new HomePage(this, settings);
        window.add(homePage);
        this.createRows = () => homePage.createRows();

        const donatePage = new DonatePage(this.metadata);
        window.add(donatePage);

        const aboutPage = new AboutPage(settings, this.metadata, this.path);
        window.add(aboutPage);

        this._setVisiblePage(window, settings);
    }

    _setVisiblePage(window, settings) {
        const prefsVisiblePage = settings.get_string('prefs-visible-page');

        window.pop_subpage();
        if (prefsVisiblePage === '') {
            window.set_visible_page_name('HomePage');
        } else if (prefsVisiblePage === 'DonatePage') {
            window.set_visible_page_name('DonatePage');
        } else if (prefsVisiblePage === 'WhatsNewPage') {
            window.set_visible_page_name('AboutPage');
            const page = window.get_visible_page();
            page.showWhatsNewPage();
        }

        settings.set_string('prefs-visible-page', '');
    }
}

const HomePage = GObject.registerClass(
class azClockHomePage extends Adw.PreferencesPage {
    _init(extension, settings) {
        super._init({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
            name: 'HomePage',
        });

        this._extension = extension;
        this._settings = settings;
        this._widgetRows = [];

        const addWidgetsButton = new Gtk.Button({
            halign: Gtk.Align.START,
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
            tooltip_text: _('Add Widget...'),
        });
        addWidgetsButton.connect('clicked', () => {
            const dialog = new AddWidgetsDialog(this._extension, this._settings, this);
            dialog.show();
            dialog.connect('response', (_w, response) => {
                if (response === Gtk.ResponseType.APPLY) {
                    this.createRows();
                    dialog.destroy();
                }
            });
        });

        const cloneWidgetsButton = new Gtk.Button({
            halign: Gtk.Align.START,
            icon_name: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
            tooltip_text: _('Clone Widget...'),
        });
        cloneWidgetsButton.connect('clicked', () => {
            const dialog = new CloneWidgetsDialog(this._extension, this._settings, this);
            dialog.show();
            dialog.connect('response', (_w, response) => {
                if (response === Gtk.ResponseType.APPLY) {
                    this.createRows();
                    dialog.destroy();
                }
            });
        });

        this._widgetsGroup = new Adw.PreferencesGroup({
            title: _('Widgets'),
            description: _('Click rows to edit widgets. Drag an drop to reorder by z-index.'),
        });
        this.add(this._widgetsGroup);

        const headerSuffixBox = new Gtk.Box({
            spacing: 6,
            orientation: Gtk.Orientation.HORIZONTAL,
        });
        headerSuffixBox.append(cloneWidgetsButton);
        headerSuffixBox.append(addWidgetsButton);

        this._widgetsGroup.set_header_suffix(headerSuffixBox);
        this.createRows();
    }

    get settings() {
        return this._settings;
    }

    createRows() {
        for (let row of this._widgetRows) {
            this._widgetsGroup.remove(row);
            row = null;
        }
        this._widgetRows = [];

        const widgets = this._settings.get_value('widgets').recursiveUnpack();
        widgets.forEach(widget => {
            for (const [widgetId] of Object.entries(widget)) {
                const widgetRow = this._createWidgetRow(widgetId);
                this._widgetsGroup.add(widgetRow);
            }
        });
    }

    _createWidgetRow(widgetId) {
        const widgetSchema = `${this._settings.schema_id}.widget-data`;
        const widgetPath = `${this._settings.path}widget-data/${widgetId}/`;
        const widgetSettings = Utils.getSettings(this._extension, widgetSchema, widgetPath);

        const name = widgetSettings.get_string('name');

        // Data for the widget is always the first element in array.
        const widgetRow = new WidgetRow(this._extension, this._settings, widgetSettings, widgetId, {
            title: `<b>${_(name)}</b>`,
        });
        widgetRow.use_markup = true;

        widgetRow.connect('drag-drop-done', (_widget, oldIndex, newIndex) => {
            const widgets = this._settings.get_value('widgets').deepUnpack();

            const movedData = widgets.splice(oldIndex, 1)[0];
            widgets.splice(newIndex, 0, movedData);

            this._settings.set_value('widgets', new GLib.Variant('aa{sv}', widgets));

            this.createRows();
        });

        this._widgetRows.push(widgetRow);
        return widgetRow;
    }
});

const WidgetRow = GObject.registerClass({
    Signals: {
        'drag-drop-done': {param_types: [GObject.TYPE_UINT, GObject.TYPE_UINT]},
        'drag-drop-prepare': {},
    },
}, class AzClockWidgetRow extends Adw.ActionRow {
    _init(extension, settings, widgetSettings, schemaId, params) {
        super._init({
            activatable: true,
            ...params,
        });
        this._extension = extension;
        this._params = params;
        this._settings = settings;
        this._widgetSettings = widgetSettings;
        this._schemaId = schemaId;

        this.dragIcon = new Gtk.Image({
            gicon: Gio.icon_new_for_string('list-drag-handle-symbolic'),
            pixel_size: 12,
        });
        this.add_prefix(this.dragIcon);

        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        this.add_controller(dragSource);

        const dropTarget = new Gtk.DropTargetAsync({actions: Gdk.DragAction.MOVE});
        this.add_controller(dropTarget);

        dragSource.connect('drag-begin', (self, gdkDrag) => {
            this._dragParent = self.get_widget().get_parent();
            this._dragParent.dragRow = this;

            const alloc = this.get_allocation();
            const dragWidget = self.get_widget().createDragRow(alloc);
            this._dragParent.dragWidget = dragWidget;

            const icon = Gtk.DragIcon.get_for_drag(gdkDrag);
            icon.set_child(dragWidget);

            gdkDrag.set_hotspot(this._dragParent.dragX, this._dragParent.dragY);
        });

        dragSource.connect('prepare', (self, x, y) => {
            this.emit('drag-drop-prepare');

            this.set_state_flags(Gtk.StateFlags.NORMAL, true);
            const parent = self.get_widget().get_parent();
            // store drag start cursor location
            parent.dragX = x;
            parent.dragY = y;
            return new Gdk.ContentProvider();
        });

        dragSource.connect('drag-end', (_self, _gdkDrag, _deleteData) => {
            this._dragParent.dragWidget = null;
            this._dragParent.drag_unhighlight_row();
            _deleteData = true;
        });

        dropTarget.connect('drag-enter', self => {
            const parent = self.get_widget().get_parent();
            const widget = self.get_widget();

            parent.drag_highlight_row(widget);
        });

        dropTarget.connect('drag-leave', self => {
            const parent = self.get_widget().get_parent();
            parent.drag_unhighlight_row();
        });

        dropTarget.connect('drop', (_self, gdkDrop) => {
            const parent = this.get_parent();
            const dragRow = parent.dragRow; // The row being dragged.
            const dragRowStartIndex = dragRow.get_index();
            const dragRowNewIndex = this.get_index();

            gdkDrop.read_value_async(AzClockWidgetRow, 1, null, () => gdkDrop.finish(Gdk.DragAction.MOVE));

            // The drag row hasn't moved
            if (dragRowStartIndex === dragRowNewIndex)
                return true;

            this.emit('drag-drop-done', dragRowStartIndex, dragRowNewIndex);
            return true;
        });

        this.connect('activated', () => {
            const widgetSettingsWindow = new WidgetSettingsPage(this._extension, this._settings, this._widgetSettings, {
                title: this._widgetSettings.get_string('name'),
                schema_id: this._schemaId,
                transient_for: this.get_root(),
                modal: true,
                resizable: false,
                default_width: 900,
                default_height: 700,
                widget_index: this.get_index(),
            });
            widgetSettingsWindow.connect('notify::title', () => (this.title = `<b>${widgetSettingsWindow.title}</b>`));
            widgetSettingsWindow.present();
        });

        const goNextImage = new Gtk.Image({
            gicon: Gio.icon_new_for_string('go-next-symbolic'),
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            vexpand: false,
        });
        this.add_suffix(goNextImage);
    }

    createDragRow(alloc) {
        const dragWidget = new Gtk.ListBox();
        dragWidget.set_size_request(alloc.width, -1);

        const dragRow = new WidgetRow(this._settings, this._widgetSettings, this._schemaId, this._params);
        dragWidget.append(dragRow);
        dragWidget.drag_highlight_row(dragRow);

        return dragWidget;
    }
});

const AddWidgetsDialog = GObject.registerClass(
class AzClockAddWidgetsDialog extends DialogWindow {
    _init(extension, settings, parent) {
        super._init(_('Add Widget'), parent);
        this._extension = extension;
        this._settings = settings;
        this.search_enabled = false;
        this.set_default_size(550, -1);

        this.pageGroup.add(this._createWidgetRow(_('Digital Clock'), WidgetType.DIGITAL));
        this.pageGroup.add(this._createWidgetRow(_('Analog Clock'), WidgetType.ANALOG));
        this.pageGroup.add(this._createWidgetRow(_('Text'), WidgetType.TEXT));
        this.pageGroup.add(this._createWidgetRow(_('Command'), WidgetType.COMMAND));
        this.pageGroup.add(this._createWidgetRow(_('Image'), WidgetType.IMAGE));
        this.pageGroup.add(this._createWidgetRow(_('Weather'), WidgetType.WEATHER));
        this.pageGroup.add(this._createWidgetRow(_('Empty Widget'), WidgetType.EMPTY,
            _('Start with an empty widget and choose which elements to add.')));
    }

    _createWidgetRow(title, widgetType, subtitle) {
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
        });

        addButton.connect('clicked', () => {
            const widgetIds = [];
            const widgets = this._settings.get_value('widgets').deepUnpack();
            widgets.forEach(widget => {
                for (const [widgetId] of Object.entries(widget))
                    widgetIds.push(widgetId);
            });

            const newWidget = {};
            const widgetFolderId = GLib.uuid_string_random();
            const widgetSchema = `${this._settings.schema_id}.widget-data`;
            const widgetPath = `${this._settings.path}widget-data/${widgetFolderId}/`;
            const widgetSettings = Utils.getSettings(this._extension, widgetSchema, widgetPath);

            const elements = [];

            if (widgetType === WidgetType.DIGITAL) {
                widgetSettings.set_string('name', _('Digital Clock Widget'));

                let elementData = this._createElement(widgetSettings);
                elements.push(elementData.element);
                elementData.settings.set_string('name', _('Time Label'));

                elementData = this._createElement(widgetSettings);
                elements.push(elementData.element);
                elementData.settings.set_string('name', _('Date Label'));
                elementData.settings.set_string('date-format', '%A %b %d');
                elementData.settings.set_int('font-size', 32);
            } else if (widgetType === WidgetType.ANALOG) {
                widgetSettings.set_string('name', _('Analog Clock Widget'));

                const {element, settings} = this._createElement(widgetSettings);
                elements.push(element);
                settings.set_string('name', _('Analog Clock'));
                settings.set_enum('element-type', Utils.ElementType.ANALOG_CLOCK);
                settings.set_value('shadow', new GLib.Variant('(bsiiii)', [true, 'rgba(55, 55, 55, 0.3)', 3, 3, 0, 0]));
                settings.set_int('border-radius', 999);
                settings.set_int('border-width', 2);
                settings.set_string('background-color', 'white');
                settings.set_boolean('show-border', true);
                settings.set_string('border-color', 'black');
                settings.set_string('foreground-color', 'black');
            } else if (widgetType === WidgetType.TEXT) {
                widgetSettings.set_string('name', _('Text Widget'));

                const {element, settings} = this._createElement(widgetSettings);
                elements.push(element);
                settings.set_string('name', _('Text Label'));
                settings.set_enum('element-type', Utils.ElementType.TEXT_LABEL);
            } else if (widgetType === WidgetType.COMMAND) {
                widgetSettings.set_string('name', _('Command Widget'));

                const {element, settings} = this._createElement(widgetSettings);
                elements.push(element);
                settings.set_string('name', _('Command Label'));
                settings.set_enum('element-type', Utils.ElementType.COMMAND_LABEL);
            } else if (widgetType === WidgetType.IMAGE) {
                widgetSettings.set_string('name', _('Image Widget'));

                const {element, settings} = this._createElement(widgetSettings);
                elements.push(element);
                settings.set_string('name', _('Image'));
                settings.set_enum('element-type', Utils.ElementType.IMAGE_ELEMENT);
            } else if (widgetType === WidgetType.WEATHER) {
                widgetSettings.set_string('name', _('Weather Widget'));
                widgetSettings.set_boolean('show-background', true);
                widgetSettings.set_string('background-color', 'rgba(0, 0, 0, .6)');

                const {element, settings} = this._createElement(widgetSettings);
                elements.push(element);
                settings.set_string('name', _('Weather Forecast'));
                settings.set_enum('element-type', Utils.ElementType.WEATHER_ELEMENT);
                settings.set_int('polling-interval', 300);
            }  else if (widgetType === WidgetType.EMPTY) {
                widgetSettings.set_string('name', _('Empty Widget'));
            }

            if (elements.length > 0)
                widgetSettings.set_value('elements', new GLib.Variant('aa{sv}', elements));

            newWidget[widgetFolderId] = new GLib.Variant('a{sv}', {
                enabled: GLib.Variant.new_boolean(true),
            });
            widgets.push(newWidget);
            this._settings.set_value('widgets', new GLib.Variant('aa{sv}', widgets));
            this.emit('response', Gtk.ResponseType.APPLY);
        });

        const row = new Adw.ActionRow({
            subtitle: subtitle ? _(subtitle) : '',
            title: _(title),
            activatable_widget: addButton,
        });

        row.add_suffix(addButton);
        return row;
    }

    _createElement(widgetSettings) {
        const randomId = GLib.uuid_string_random();
        const elementSchema = `${this._settings.schema_id}.element-data`;
        const elementPath = `${widgetSettings.path}element-data/`;

        const element = {};
        element[randomId] = new GLib.Variant('a{sv}', {
            enabled: GLib.Variant.new_boolean(true),
        });

        const settings = Utils.getSettings(this._extension, elementSchema, `${elementPath}${randomId}/`);

        return {element, settings};
    }
});

const CloneWidgetsDialog = GObject.registerClass(
class AzClockCloneWidgetsDialog extends DialogWindow {
    _init(extension, settings, parent) {
        super._init(_('Clone Widget'), parent);
        this._extension = extension;
        this._settings = settings;
        this.search_enabled = false;
        this.set_default_size(550, -1);

        const widgets = this._settings.get_value('widgets').recursiveUnpack();
        widgets.forEach(widget => {
            for (const [widgetId] of Object.entries(widget)) {
                const widgetSchema = `${this._settings.schema_id}.widget-data`;
                const widgetPath = `${this._settings.path}widget-data/${widgetId}/`;
                const widgetSettings = Utils.getSettings(this._extension, widgetSchema, widgetPath);

                const name = widgetSettings.get_string('name');
                this.pageGroup.add(this._createWidgetRow(name, widgetSettings));
            }
        });
    }

    _createWidgetRow(title, widgetType, subtitle) {
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
        });

        addButton.connect('clicked', () => {
            const widgetIds = [];
            const widgets = this._settings.get_value('widgets').deepUnpack();
            widgets.forEach(widget => {
                for (const [widgetId] of Object.entries(widget))
                    widgetIds.push(widgetId);
            });

            const newWidget = {};
            const widgetFolderId = GLib.uuid_string_random();
            const widgetSchema = `${this._settings.schema_id}.widget-data`;
            const widgetPath = `${this._settings.path}widget-data/${widgetFolderId}/`;
            const widgetSettings = Utils.getSettings(this._extension, widgetSchema, widgetPath);

            const elementSchema = `${this._settings.schema_id}.element-data`;
            const elementPath = `${widgetSettings.path}element-data/`;

            const setValue = (copySetting, newSetting, key) => {
                const defaultValue = copySetting.get_default_value(key);
                const value = copySetting.get_value(key);
                if (!defaultValue.equal(value))
                    newSetting.set_value(key, value);
            };

            const copyWidgetSettings = widgetType;
            const copyElements = copyWidgetSettings.get_value('elements').deepUnpack();
            const copyElementPath = `${copyWidgetSettings.path}element-data/`;

            const keys = copyWidgetSettings.settings_schema.list_keys();
            for (const key of keys)
                setValue(copyWidgetSettings, widgetSettings, key);

            copyElements.forEach(element => {
                for (const [elementId] of Object.entries(element)) {
                    const copyElementSettings = Utils.getSettings(this._extension, elementSchema, `${copyElementPath}${elementId}/`);

                    const elementSettings = Utils.getSettings(this._extension, elementSchema, `${elementPath}${elementId}/`);
                    const elementKeys = copyElementSettings.settings_schema.list_keys();
                    for (const key of elementKeys)
                        setValue(copyElementSettings, elementSettings, key);
                }
            });

            newWidget[widgetFolderId] = new GLib.Variant('a{sv}', {
                enabled: GLib.Variant.new_boolean(true),
            });
            widgets.push(newWidget);
            this._settings.set_value('widgets', new GLib.Variant('aa{sv}', widgets));
            this.emit('response', Gtk.ResponseType.APPLY);
        });

        const row = new Adw.ActionRow({
            subtitle: subtitle ? _(subtitle) : '',
            title: _(title),
            activatable_widget: addButton,
        });

        row.add_suffix(addButton);
        return row;
    }
});
