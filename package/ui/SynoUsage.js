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
            html: '<iframe title="SynoUsage" src="/webman/3rdparty/h5uSynoUsage/index.html?v=__SYNOUSAGE_BUILD__" style="display:block;width:100%;height:100%;border:0" referrerpolicy="same-origin"></iframe>'
        }, options));
    }
});
