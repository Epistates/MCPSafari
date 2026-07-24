function show(enabled) {
    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

function enableNativeInput() {
    webkit.messageHandlers.controller.postMessage("enable-native-input");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
document.querySelector("button.enable-native-input").addEventListener("click", enableNativeInput);
