import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import GWeather from 'gi://GWeather';
import NM from 'gi://NM';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import * as Utils from '../utils.js';
import * as WeatherUtils from './weatherUtils.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(NM.Client, 'new_async');

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL = 3; // seconds

const IconType = {
    SYMBOLIC: 0,
    FULL_COLOR: 1,
};

function convertUnit(value, toUnit) {
    if (toUnit === GWeather.TemperatureUnit.FAHRENHEIT)
        return (value * 9 / 5) + 32;
    else if (toUnit === GWeather.TemperatureUnit.CENTIGRADE)
        return (value - 32) * 5 / 9;
    else
        return value;
}

function getTemperatureUnit(unit) {
    const temperatureUnit = WeatherUtils.getTemperatureUnit(unit);
    const main = GWeather.temperature_unit_to_real(temperatureUnit);
    const F = GWeather.TemperatureUnit.FAHRENHEIT;
    const C = GWeather.TemperatureUnit.CENTIGRADE;
    const alt = main === F ? C : F;

    return {main, alt};
}

function formatTemperature(value, showDegreeSign = false, unit = null) {
    if (typeof value !== 'number')
        return '--';

    const roundedTemp = Math.round(value).toFixed(0);

    // '\u00B0' - Degree Sign
    const tempString = showDegreeSign ? `${roundedTemp}\u00B0` : `${roundedTemp}`;

    if (!unit)
        return tempString;

    /** TRANSLATORS: F AND C represent temperature unit labels for Fahrenheit and Celsius*/
    const unitChar = unit === GWeather.TemperatureUnit.FAHRENHEIT ? _('F')
    /** TRANSLATORS: F AND C represent temperature unit labels for Fahrenheit and Celsius*/
        : _('C');
    return tempString.concat('', unitChar);
}

function buildTemperatureString(temperatureUnit, showBothTempUnits, value, formatText, newLine = true) {
    const {main, alt} = getTemperatureUnit(temperatureUnit);

    const mainTempString = formatText(value, main);
    const altTempRaw = convertUnit(value, alt);
    const altTempStringRaw = formatText(altTempRaw, alt);
    const altTempString = newLine ? `\n${altTempStringRaw}` : ` (${altTempStringRaw})`;

    const tempString = mainTempString + (showBothTempUnits ? `${altTempString}` : '');
    return tempString;
}

function setActorStyle(settings, actor, style = '') {
    const [shadowEnabled, shadowColor, shadowX, shadowY,
        shadowSpread, shadowBlur] = settings.get_value('weather-actor-shadow').deepUnpack();
    const [customFontEnabled, customFontFamily] = settings.get_value('font-family-override').deepUnpack();
    const textColor = settings.get_string('foreground-color');
    const iconColor = settings.get_string('icon-color');

    let shadowType, color;

    if (actor instanceof St.Label) {
        shadowType = 'text-shadow';
        color = textColor;
    } else if (actor instanceof St.Icon) {
        shadowType = 'icon-shadow';
        color = iconColor;
    } else {
        shadowType = 'box-shadow';
        color = textColor;
    }

    style += `color: ${color};`;

    if (actor instanceof St.Label) {
        actor.clutter_text.set({
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        style += ' font-feature-settings: "tnum";';
    }

    if (shadowEnabled)
        style += `${shadowType}: ${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowSpread}px ${shadowColor};`;

    if (customFontEnabled && actor instanceof St.Label) {
        const fontStyleEnum = settings.get_enum('font-style');
        const fontStyle = Utils.fontStyleEnumToString(fontStyleEnum);
        const fontWeight = settings.get_int('font-weight');

        style += ` font-family: "${customFontFamily}";`;

        if (fontWeight)
            style += ` font-weight: ${fontWeight};`;
        if (fontStyle)
            style += ` font-style: ${fontStyle};`;
    }
    if (!actor.style)
        actor.style = style;
    else
        actor.style += style;
}

export const WeatherElement = GObject.registerClass(
class AzClockWeatherElement extends St.Widget {
    _init(settings, extension) {
        super._init({
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            pivot_point: new Graphene.Point({x: 0.5, y: .5}),
            layout_manager: new Clutter.BoxLayout(),
        });

        this._isLoading = false;

        this.layout_manager.set({
            spacing: 28,
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._settings = settings;
        this._extension = extension;
        this._world = GWeather.Location.get_world();

        this._setTemperatureUnits();
        this._createWeatherGrids();

        this._settings.connectObject('changed::polling-interval', () => this.refreshWeather(), this);
        this._settings.connectObject('changed::locations', () => this._setWeatherInfo(), this);

        this._settings.connectObject('changed', () => this._sync(), this);
        this._setWeatherInfo();

        this.connect('destroy', () => this._onDestroy());
        this._createNMClient().catch(e => console.log(e));
    }

    _createWeatherGrids() {
        this._currentWeatherGrid = null;
        this._forecastGrid = null;
        this._dailyForecastGrid = null;

        const currentWeatherLayout = new Clutter.GridLayout({
            column_spacing: 6,
            row_spacing: 2,
        });
        this._currentWeatherGrid = new St.Widget({
            layout_manager: currentWeatherLayout,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        currentWeatherLayout.hookup_style(this._currentWeatherGrid);
        this.add_child(this._currentWeatherGrid);

        const forecastLayout = new Clutter.GridLayout({
            column_spacing: 20,
            row_spacing: 10,
        });
        this._forecastGrid = new St.Widget({
            layout_manager: forecastLayout,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        forecastLayout.hookup_style(this._forecastGrid);
        this.add_child(this._forecastGrid);

        const dailyForecastLayout = new Clutter.GridLayout({
            column_spacing: 20,
            row_spacing: 10,
        });
        this._dailyForecastGrid = new St.Widget({
            layout_manager: dailyForecastLayout,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        dailyForecastLayout.hookup_style(this._dailyForecastGrid);
        this.add_child(this._dailyForecastGrid);
    }

    async _createNMClient() {
        this._client = await NM.Client.new_async(null);
        this._client.connectObject('notify::connectivity', () => this._onConnectivityChanged(), this);
    }

    _onConnectivityChanged() {
        const connectivity = this._client.get_connectivity();

        if (connectivity === NM.ConnectivityState.FULL) {
            this._attemptReconnect = false;
            this._setWeatherInfo();
        } else {
            this._attemptReconnect = false;
            this._setStatusLabel(_('Go Online for Weather Information'));
        }
    }

    _setStatusLabel(status, needsReconnect = true) {
        this._removePollingInterval();
        this.destroy_all_children();
        this._createWeatherGrids();
        this.queue_relayout();
        this._forecastGrid.visible = false;
        this._dailyForecastGrid.visible = false;
        const layout = this._currentWeatherGrid.layout_manager;
        const errorLabel = new St.Label({
            text: _(status),
            x_align: Clutter.ActorAlign.START,
            style: 'text-align: center; font-size: 12pt;',
        });
        layout.attach(errorLabel, 0, 0, 1, 1);

        if (!needsReconnect) {
            this.queue_relayout();
            return;
        }

        if (this._reconnectCount === MAX_RECONNECT_ATTEMPTS) {
            const reloadButton = new St.Button({
                style_class: 'icon-button',
                icon_name: 'view-refresh-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
            });
            reloadButton.connect('clicked', () => {
                this.refreshWeather();
            });
            layout.attach(reloadButton, 0, 1, 1, 1);
        } else {
            const reconnectingLabel = new St.Label({
                text: _('Retrying...'),
                x_align: Clutter.ActorAlign.START,
                style: 'text-align: center; font-size: 12pt;',
            });
            layout.attach(reconnectingLabel, 0, 1, 1, 1);
        }

        this.queue_relayout();

        // If there is an error gathering the weather info, add a 3 second Glib.timeout that runs 3 times
        // to attempt to retry to gather the weather info.
        if (!this._attemptReconnect)
            this._startReconnectAttempt();
    }

    refreshWeather() {
        this._reconnectCount = 0;
        this._setStatusLabel(_('Refresh Weather'), false);
        this._attemptReconnect = false;
        this._removeReconnectId();
        this._removePollingInterval();
        this._setWeatherInfo();
    }

    _startReconnectAttempt() {
        this._attemptReconnect = true;
        this._reconnectCount = 0;
        this._reconnectId = GLib.timeout_add_seconds(GLib.PRIORITY_HIGH, RECONNECT_INTERVAL, () => {
            this._reconnectCount++;
            this._setWeatherInfo();

            if (this._reconnectCount === MAX_RECONNECT_ATTEMPTS) {
                this._reconnectId = null;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _removeReconnectId() {
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = null;
        }
    }

    _startPollingInterval() {
        const pollingInterval = this._settings.get_int('polling-interval');
        this._pollingIntervalId = GLib.timeout_add_seconds(GLib.PRIORITY_HIGH, pollingInterval, () => {
            this._loadInfo();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _removePollingInterval() {
        if (this._pollingIntervalId) {
            GLib.source_remove(this._pollingIntervalId);
            this._pollingIntervalId = null;
        }
    }

    _setWeatherInfo() {
        const locations = this._settings.get_value('locations').deepUnpack();
        const serialized = locations.shift();
        if (!serialized) {
            this._setStatusLabel(_('Location not set!'), false);
            return;
        }

        // Disconnect the previous weatherInfo
        if (this._updatedId && this._weatherInfo) {
            this._weatherInfo.disconnect(this._updatedId);
            this._updatedId = null;
        }

        const providers =
            GWeather.Provider.METAR |
            GWeather.Provider.MET_NO |
            GWeather.Provider.OWM;

        const location = this._world.deserialize(serialized);
        this._weatherInfo = new GWeather.Info({
            application_id: 'org.gnome.Shell',
            contact_info: 'https://gitlab.gnome.org/GNOME/gnome-shell/-/raw/HEAD/gnome-shell.doap',
            enabled_providers: providers,
            location,
        });

        this._updatedId = this._weatherInfo.connect_after('updated', () => {
            this._sync();
            this.queue_relayout();
        });
        this._loadInfo();
        this.queue_relayout();
    }

    _loadInfo() {
        if (!this._weatherInfo)
            return;

        if (this._loadingId) {
            this._weatherInfo.disconnect(this._loadingId);
            this._loadingId = null;
        }

        this._loadingId = this._weatherInfo.connect('updated', () => {
            this._weatherInfo.disconnect(this._loadingId);
            this._loadingId = null;
            this._isLoading = false;
        });

        this._isLoading = true;
        this._weatherInfo.update();
    }

    _sync() {
        this._setTemperatureUnits();

        if (!this._weatherInfo)
            return;

        if (this._isLoading) {
            this._setStatusLabel(_('Loading…'), false);
            return;
        }

        if (this._weatherInfo.is_valid()) {
            this._displayWeather();
            this._removeReconnectId();
            this._startPollingInterval();
            return;
        }

        if (this._weatherInfo.network_error())
            this._setStatusLabel(_('Go Online for Weather Information'));
        else
            this._setStatusLabel(_('Weather Information Unavailable'));
    }

    _setTemperatureUnits() {
        const temperatureUnit = this._settings.get_enum('temperature-unit');
        const {main, alt} = getTemperatureUnit(temperatureUnit);
        this._mainTempUnit = main;
        this._altTempUnit = alt;
    }

    _displayWeather() {
        this.destroy_all_children();
        this._createWeatherGrids();

        this.queue_relayout();

        const showCurrent = this._settings.get_boolean('show-current-conditions');
        const showHourly = this._settings.get_boolean('show-hourly-forecast');
        const showDaily = this._settings.get_boolean('show-daily-forecast');

        this._currentWeatherGrid.visible = showCurrent;
        if (showCurrent)
            this._getCurrentWeather();

        this._forecastGrid.visible = showHourly;
        if (showHourly)
            this._getHourlyForecast();

        this._dailyForecastGrid.visible = showDaily;
        if (showDaily)
            this._getDailyForecast();

        this.queue_relayout();
    }

    _getCurrentWeather() {
        const layout = this._currentWeatherGrid.layout_manager;
        if (!layout)
            return;

        const formatTempText = (temp, unit) => {
            const showDegreeSign = this._settings.get_boolean('current-conditions-show-temp-degree-sign');
            const showUnit = this._settings.get_boolean('current-conditions-show-temp-unit');
            return formatTemperature(temp, showDegreeSign, showUnit ? unit : null);
        };

        const showBothTempUnits = this._settings.get_boolean('current-conditions-show-both-temps');

        const [, temp] = this._weatherInfo.get_value_temp(this._mainTempUnit);
        const tempAlt = convertUnit(temp, this._altTempUnit);
        const [, tempApparent] = this._weatherInfo.get_value_apparent(this._mainTempUnit);

        const iconName = this._weatherInfo.get_icon_name();
        const iconSymbolicName = this._weatherInfo.get_symbolic_icon_name();
        const summary = this._weatherInfo.get_weather_summary();
        const humidity = this._weatherInfo.get_humidity();

        const iconType = this._settings.get_enum('current-weather-icon-type');
        const showHumidity = this._settings.get_boolean('show-current-humidity');
        const showConditions = this._settings.get_boolean('show-current-summary');
        const showApparentTemp = this._settings.get_boolean('show-current-apparent-temp');
        const showLocation = this._settings.get_boolean('show-location');

        const temperatureUnit = this._settings.get_enum('temperature-unit');
        const location = this._weatherInfo.get_location_name();

        if (showLocation) {
            const locationLabel = new St.Label({
                text: location,
                x_align: Clutter.ActorAlign.START,
            });
            setActorStyle(this._settings, locationLabel, 'text-align: center; font-size: 12pt;');
            layout.attach(locationLabel, 1, 0, 1, 3);
        }

        const icon = new St.Icon({
            icon_name: iconType === IconType.SYMBOLIC ? iconSymbolicName : iconName,
            x_align: Clutter.ActorAlign.START,
            x_expand: false,
            icon_size: 62,
        });
        setActorStyle(this._settings, icon);
        layout.attach(icon, 0, 0, 1, 3);

        const padding = showLocation ? ' padding-top: 12px;' : ' padding-top: 0px;';

        const formattedTempText = formatTempText(temp, this._mainTempUnit);
        const tempLabel = new St.Label({
            text: formattedTempText,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setActorStyle(this._settings, tempLabel, `text-align: center; font-size: 32pt;${padding}`);
        layout.attach(tempLabel, 1, 0, 1, 3);

        if (showBothTempUnits) {
            const tempAltText = formatTempText(tempAlt, this._altTempUnit);
            const tempAltLabel = new St.Label({
                text: tempAltText,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            setActorStyle(this._settings, tempAltLabel, `text-align: center; font-size: 9pt;${padding}`);
            layout.attach(tempAltLabel, 1, 2, 1, 3);
        }

        let y = 0;

        if (showHumidity) {
            const humidityLabel = new St.Label({
                text: _('Humidity: %s').format(humidity),
                x_align: Clutter.ActorAlign.END,
                x_expand: true,
            });
            setActorStyle(this._settings, humidityLabel, 'text-align: center; font-size: 9pt;');
            layout.attach(humidityLabel, 2, y, 1, 1);
            y++;
        }

        if (showConditions) {
            const conditions = new St.Label({
                text: `${summary.replace(`${location}: `, '')}`,
                x_align: Clutter.ActorAlign.END,
                x_expand: true,
            });
            setActorStyle(this._settings, conditions, 'text-align: center; font-size: 9pt;');
            layout.attach(conditions, 2, y, 1, 1);
            y++;
        }

        if (showApparentTemp) {
            const tempApparentText = buildTemperatureString(temperatureUnit, showBothTempUnits, tempApparent, formatTempText, false);
            const feelsLike = new St.Label({
                text: _('Feels like %s').format(tempApparentText),
                x_align: Clutter.ActorAlign.END,
                x_expand: true,
            });
            setActorStyle(this._settings, feelsLike, 'text-align: center; font-size: 9pt;');
            layout.attach(feelsLike, 2, y, 1, 1);
        }
    }

    _getHourlyForecast() {
        const forecasts = this._weatherInfo.get_forecast_list();
        const maxForecasts = this._settings.get_int('max-hourly-forecasts');
        const forecast = WeatherUtils.getHourlyForecast(this._weatherInfo, forecasts, maxForecasts);
        if (!forecast)
            return;

        const formatTempText = (temp, unit) => {
            const showDegreeSign = this._settings.get_boolean('hourly-forecast-show-temp-degree-sign');
            const showUnit = this._settings.get_boolean('hourly-forecast-show-temp-unit');
            return formatTemperature(temp, showDegreeSign, showUnit ? unit : null);
        };

        const temperatureUnit = this._settings.get_enum('temperature-unit');
        const showBothTempUnits = this._settings.get_boolean('hourly-forecast-show-both-temps');
        const iconType = this._settings.get_enum('hourly-weather-icon-type');

        const layout = this._forecastGrid.layout_manager;
        let col = 0;
        forecast.forEach(data => {
            const iconName = data.get_icon_name();
            const iconSymbolicName = data.get_symbolic_icon_name();

            const [, temp] = data.get_value_temp(this._mainTempUnit);
            const [valid_, timestamp] = data.get_value_update();
            const timeStr = formatTime(new Date(timestamp * 1000), {
                timeOnly: true,
                ampm: false,
            });

            const time = new St.Label({
                text: timeStr,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
            });
            setActorStyle(this._settings, time, 'text-align: center; font-size: 9pt;');
            const icon = new St.Icon({
                icon_name: iconType === IconType.SYMBOLIC ? iconSymbolicName : iconName,
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                icon_size: 34,
            });
            setActorStyle(this._settings, icon);

            const tempText = buildTemperatureString(temperatureUnit, showBothTempUnits, temp, formatTempText);
            const tempLabel = new St.Label({
                text: tempText,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
            });
            setActorStyle(this._settings, tempLabel, 'text-align: center; font-size: 9pt;');

            layout.attach(time, col, 0, 1, 1);
            layout.attach(icon, col, 1, 1, 1);
            layout.attach(tempLabel, col, 2, 1, 1);
            col++;
        });
    }

    _getDailyForecast() {
        const forecasts = this._weatherInfo.get_forecast_list();
        const maxForecasts = this._settings.get_int('max-daily-forecasts');
        const forecast = WeatherUtils.getDailyForecast(forecasts, maxForecasts, this._mainTempUnit);
        if (!forecast)
            return;

        const formatTempText = (temp, unit) => {
            const showDegreeSign = this._settings.get_boolean('daily-forecast-show-temp-degree-sign');
            const showUnit = this._settings.get_boolean('daily-forecast-show-temp-unit');
            return formatTemperature(temp, showDegreeSign, showUnit ? unit : null);
        };

        const temperatureUnit = this._settings.get_enum('temperature-unit');
        const showBothTempUnits = this._settings.get_boolean('daily-forecast-show-both-temps');
        const iconType = this._settings.get_enum('daily-weather-icon-type');
        const showThermometerScale = this._settings.get_boolean('show-daily-forecast-thermometer-scale');

        let weeklyMax, weeklyMin;
        const layout = this._dailyForecastGrid.layout_manager;
        let row = 0;
        forecast.forEach(dayData => {
            const dateFormat = this._settings.get_string('daily-forecast-date-format');
            const dateString = `${dayData.datetime.format(dateFormat)}`;
            const maxTemp = dayData.maxTemp;
            const minTemp = dayData.minTemp;
            weeklyMax = Math.round(dayData.weekHighestTemp).toFixed(0);
            weeklyMin = Math.round(dayData.weekLowestTemp).toFixed(0);

            const iconName = `${dayData.day.get_icon_name()}-small`;
            const iconSymbolicName = dayData.day.get_symbolic_icon_name();

            const dateLabel = new St.Label({
                text: dateString,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            setActorStyle(this._settings, dateLabel, 'text-align: center; font-size: 9pt;');
            const icon = new St.Icon({
                icon_name: iconType === IconType.SYMBOLIC ? iconSymbolicName : iconName,
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                icon_size: 16,
            });
            setActorStyle(this._settings, icon);

            let temperatureWidget = null;
            if (showThermometerScale) {
                temperatureWidget = new ThermometerWidget(this._settings, maxTemp, minTemp, weeklyMax, weeklyMin);
            } else {
                const maxTempTextAlt = buildTemperatureString(temperatureUnit, showBothTempUnits, maxTemp, formatTempText, false);
                const minTempTextAlt = buildTemperatureString(temperatureUnit, showBothTempUnits, minTemp, formatTempText, false);
                temperatureWidget = new St.Label({
                    text: `${maxTempTextAlt} | ${minTempTextAlt}`,
                    x_align: Clutter.ActorAlign.END,
                    x_expand: true,
                });
                setActorStyle(this._settings, temperatureWidget, 'text-align: center; font-size: 9pt;');
            }

            layout.attach(dateLabel, 0, row, 1, 1);
            layout.attach(icon, 1, row, 1, 1);
            layout.attach(temperatureWidget, 2, row, 1, 1);
            row++;
        });
    }

    _onDestroy() {
        this._client.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._removePollingInterval();
        this._removeReconnectId();

        if (this._updatedId) {
            this._weatherInfo.disconnect(this._updatedId);
            this._updatedId = null;
        }

        if (this._loadingId) {
            this._weatherInfo.disconnect(this._loadingId);
            this._loadingId = null;
        }

        this._world = null;
        this._client = null;
        this._weatherInfo = null;
        this._settings = null;
        this._extension = null;
    }
});

const ThermometerScale = GObject.registerClass(
class AzClockThermometerScale extends St.DrawingArea {
    _init(dayHigh, dayLow, weeklyHigh, weeklyLow) {
        super._init({
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            width: 140,
            height: 6,
        });

        this._dayHigh = Math.round(dayHigh).toFixed(0);
        this._dayLow = Math.round(dayLow).toFixed(0);
        this._weeklyHigh = weeklyHigh;
        this._weeklyLow = weeklyLow;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        const weeklyRange = (this._weeklyHigh - this._weeklyLow) || 1;
        const factor = width / weeklyRange;
        const gradientWidth = Math.max(factor * (this._dayHigh - this._dayLow), 6);

        const x = factor * (this._dayLow - this._weeklyLow);
        const y = 0;

        // Draw the background
        const fill = Cairo.SolidPattern.createRGBA(0.25, 0.25, 0.25, 1.0);
        drawRoundedLine(cr, 0, 0, width, height, fill);

        // Create a linear gradient for the temperature bar
        const gradient = new Cairo.LinearGradient(x, y, x + gradientWidth, height);
        gradient.addColorStopRGBA(0, 0.43, 0.76, 0.89, 0.8);
        gradient.addColorStopRGBA(1, 0.45, 0.88, 0.46, 0.8);

        // Draw the temperature bar
        drawRoundedLine(cr, x, y, gradientWidth, height, gradient);

        cr.$dispose();
    }
});

const ThermometerWidget = GObject.registerClass(
class AzClockThermometerWidget extends St.BoxLayout {
    _init(settings, dayHigh, dayLow, weeklyHigh, weeklyLow) {
        super._init({
            style: 'spacing: 4px;',
        });

        const formatTempText = (temp, unit) => {
            const showDegreeSign = settings.get_boolean('daily-forecast-show-temp-degree-sign');
            const showUnit = settings.get_boolean('daily-forecast-show-temp-unit');
            return formatTemperature(temp, showDegreeSign, showUnit ? unit : null);
        };

        const temperatureUnit = settings.get_enum('temperature-unit');
        const showBothTempUnits = settings.get_boolean('daily-forecast-show-both-temps');

        const maxtempText = buildTemperatureString(temperatureUnit, showBothTempUnits, dayHigh, formatTempText);
        const tempMax = new St.Label({
            text: `${maxtempText}`,
            x_align: Clutter.ActorAlign.END,
            x_expand: false,
        });
        setActorStyle(settings, tempMax, 'text-align: right; font-size: 9pt;');

        const minTempText = buildTemperatureString(temperatureUnit, showBothTempUnits, dayLow, formatTempText);
        const tempMin = new St.Label({
            text: `${minTempText}`,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        setActorStyle(settings, tempMin, 'text-align: right; font-size: 9pt;');

        const thermometerScale = new ThermometerScale(dayHigh, dayLow, weeklyHigh, weeklyLow);
        const thermometerScaleWidget = new St.Widget({
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        thermometerScaleWidget.add_child(thermometerScale);
        setActorStyle(settings, thermometerScaleWidget);

        this.add_child(tempMin);
        this.add_child(thermometerScaleWidget);
        this.add_child(tempMax);
    }
});

function drawRoundedLine(cr, x, y, width, height, fill) {
    const DEGREES = Math.PI / 180;
    const RADIUS = height / 2.0;

    cr.newSubPath();
    cr.arc(x + RADIUS, y + RADIUS, RADIUS, 90 * DEGREES, 270 * DEGREES);
    cr.arc(x + width - RADIUS, y + RADIUS, RADIUS, 270 * DEGREES, 90 * DEGREES);
    cr.closePath();

    if (fill) {
        cr.setSource(fill);
        cr.fillPreserve();
    }
    cr.fill();
}

