<b><span size="large">v16.0</span></b>

- Add GNOME 50 support.
- Command Label: add "Run Command Repeatedly" toggle setting.
- Command Label: Replace the stop-on-error behavior with exponential backoff.
    - On failure: double the polling interval (capped at 5 minutes) and restart the timer.
    - On success: reset to the configured polling interval.
    - On settings change: reset backoff state.
- Weather Widget: add settings to display both F and C temperatures.
- Settings UI improvements/changes.