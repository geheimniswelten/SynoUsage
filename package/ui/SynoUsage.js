Ext.namespace("SYNO.SDS.h5uSynoUsage");
Ext.define("SYNO.SDS.h5uSynoUsage.Application", {
    extend: "SYNO.SDS.AppInstance",
    appWindowName: "SYNO.SDS.h5uSynoUsage.MainWindow"
});
Ext.define("SYNO.SDS.h5uSynoUsage.MainWindow", {
    extend: "SYNO.SDS.AppWindow",
    constructor: function (options) {
        this.appInstance = options.appInstance;
        SYNO.SDS.h5uSynoUsage.MainWindow.superclass.constructor.call(this, Ext.apply({
            title: "SynoUsage", layout: "fit", cls: "syno-app-win",
            width: 1100, height: 740, minWidth: 650, minHeight: 440,
            resizable: true, maximizable: true, minimizable: true,
            html: '<iframe class="synousage-frame" title="SynoUsage" src="/webman/3rdparty/h5uSynoUsage/index.html?v=__SYNOUSAGE_BUILD__&amp;open=' + Date.now() + '" style="display:block;width:100%;height:100%;border:0" referrerpolicy="same-origin"></iframe>'
        }, options));
    },

    afterRender: function () {
        SYNO.SDS.h5uSynoUsage.MainWindow.superclass.afterRender.apply(this, arguments);
        const frame = this.body.dom.querySelector(".synousage-frame");
        if (!frame) return;

        const desktop = frame.ownerDocument;
        const listeners = new AbortController();
        const capture = {capture: true, signal: listeners.signal};
        let frameDocument;
        const activate = (event) => {
            if (event.button === 0) {
                // DSM expects an Ext event whose target belongs to its desktop document.
                this.toFront({getTarget: () => frame});
            }
        };
        const bindFrame = () => {
            frameDocument?.removeEventListener("pointerdown", activate, true);
            frameDocument = frame.contentDocument;
            frameDocument?.addEventListener("pointerdown", activate, true);
        };
        frame.addEventListener("load", bindFrame, capture);
        bindFrame();

        const pointerEvents = frame.style.pointerEvents;
        let desktopPointer = null;
        const releasePointer = () => {
            if (desktopPointer === null) return;
            desktopPointer = null;
            frame.style.pointerEvents = pointerEvents;
        };
        // Capture the press before DSM's drag threshold. Even the first move
        // can cross into the frame and would then miss DSM's drag handlers.
        desktop.addEventListener("pointerdown", (event) => {
            if (!event.isPrimary || event.button !== 0) return;
            desktopPointer = event.pointerId;
            frame.style.pointerEvents = "none";
        }, capture);
        const endDesktopPress = (event) => {
            if (event.pointerId === desktopPointer) releasePointer();
        };
        desktop.addEventListener("pointerup", endDesktopPress, capture);
        desktop.addEventListener("pointercancel", endDesktopPress, capture);
        desktop.addEventListener("pointermove", (event) => {
            if (!(event.buttons & 1)) endDesktopPress(event);
        }, capture);
        desktop.defaultView.addEventListener("blur", releasePointer, {signal: listeners.signal});

        this.removeFrameListeners = () => {
            listeners.abort();
            frameDocument?.removeEventListener("pointerdown", activate, true);
            releasePointer();
        };
    },

    beforeDestroy: function () {
        this.removeFrameListeners?.();
        SYNO.SDS.h5uSynoUsage.MainWindow.superclass.beforeDestroy.apply(this, arguments);
    }
});
