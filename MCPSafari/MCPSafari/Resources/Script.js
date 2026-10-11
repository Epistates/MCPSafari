// `enabled` true or false is Safari's answer; null means Safari would not give
// one, which is not the same as "not enabled" and must not be shown as it.
function show(enabled) {
    document.body.classList.toggle(`state-on`, enabled === true);
    document.body.classList.toggle(`state-off`, enabled === false);
    document.body.classList.toggle(`state-error`, enabled === null);
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

// Safari can refuse to open its own settings pane, in which case nothing
// happens on screen and the button reads as broken. Say so instead.
function showPreferencesError(message) {
    const note = document.querySelector(".preferences-note");
    note.textContent = `Safari would not open its settings: ${message} Open Safari > Settings > Extensions yourself.`;
    note.hidden = false;
}

function enableNativeInput() {
    webkit.messageHandlers.controller.postMessage("enable-native-input");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
document.querySelector("button.enable-native-input").addEventListener("click", enableNativeInput);
