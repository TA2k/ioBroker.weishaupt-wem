"use strict";

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

//disable canvas because of missing rebuild
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function () {
    if (arguments[0] === "canvas") {
        return { createCanvas: null, createImageData: null, loadImage: null };
    }
    return originalRequire.apply(this, arguments);
};
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

const axios = require("axios").default;
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");

const jsdom = require("jsdom");
const json2iob = require("json2iob");
const { JSDOM } = jsdom;
class WeishauptWem extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "weishaupt-wem",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create({
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                cookies: {
                    jar: this.cookieJar,
                },
            }),
        });
        this.refreshTokenInterval = null;
        this.updateInterval = null;
        this.dataPointId = 0;
        this.deviceArray = [];
        this.json2iob = new json2iob(this);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        this.setState("info.connection", false, true);
        // Reset the connection indicator during startup

        await this.login();
        await this.switchFachmann();
        await this.getStatus();
        if (this.config.useApp) {
            this.log.info("Start App Login");
            const isLoggedInApp = await this.loginApp();
            if (isLoggedInApp) {
                await this.getAppDevices();
                await this.getParameters();
                await this.getAppStatus();
            }
        }
        this.updateInterval = setInterval(() => {
            this.getStatus();

            if (this.config.useApp) {
                this.getAppStatus();
            }
        }, this.config.interval * 60 * 1000);

        this.subscribeStates("*");
    }

    async loginApp() {
        return await this.requestClient({
            method: "post",
            maxBodyLength: Infinity,
            url: "https://www.wemportal.com/app/Account/Login",
            headers: {
                "Content-Type": "application/json",
                "X-Api-Version": "2.0.0.0",
                Accept: "application/json",
                "User-Agent": "WeishauptWEMApp",
                "Accept-Language": "de-de",
                Connection: "keep-alive",
            },
            data: {
                AppVersion: "2.3",
                PasswordUTF8: this.config.password,
                AppID: "de.weishaupt.wemapp",
                ClientOS: "iOS",
                Name: this.config.user,
            },
        })
            .then((resp) => {
                this.log.debug(resp.data);
                if (resp && resp.data.Status === 0) {
                    this.log.info("App Login successful");
                    return true;
                } else {
                    this.log.error(JSON.stringify(resp.data));
                    this.log.error("App Login failed");
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(error.response.data);
            });
    }
    async getAppDevices() {
        await this.requestClient({
            method: "get",
            maxBodyLength: Infinity,
            url: "https://www.wemportal.com/app/Device/Read",
            headers: {
                "Content-Type": "application/json",
                "X-Api-Version": "2.0.0.0",
                Accept: "application/json",
                "User-Agent": "WeishauptWEMApp",
                "Accept-Language": "de-de",
                Connection: "keep-alive",
            },
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                this.log.info(`App Found ${res.data.Devices.length} devices`);
                for (const device of res.data.Devices) {
                    const id = device.ID.toString();

                    this.deviceArray.push(device);
                    const name = device.Name;

                    await this.setObjectNotExistsAsync(id, {
                        type: "device",
                        common: {
                            name: name + " via App",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(id + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                        },
                        native: {},
                    });

                    const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(id + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                def: remote.def || false,
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.json2iob.parse(id, device, { preferedArrayName: "Index+Type", preferedArrayDesc: "Name" });
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(error.response.data);
            });
    }
    async getParameters() {
        for (const device of this.deviceArray) {
            for (const modules of device.Modules) {
                this.log.debug(`App Fetch Status for ${device.Name} - ${modules.Name} (${modules.Type})`);
                if (modules.Name === "System " || modules.Name === "Test") {
                    continue;
                }
                await this.requestClient({
                    method: "post",
                    maxBodyLength: Infinity,
                    url: "https://www.wemportal.com/app/EventType/Read",
                    headers: {
                        Host: "www.wemportal.com",
                        "Content-Type": "application/json",
                        "X-Api-Version": "2.0.0.0",
                        Accept: "application/json",
                        "User-Agent": "WeishauptWEMApp",
                        "Accept-Language": "de-de",
                        Connection: "keep-alive",
                    },
                    data: {
                        DeviceID: device.ID,
                        ModuleType: modules.Type,
                        ModuleIndex: modules.Index,
                    },
                })
                    .then((res) => {
                        this.log.debug(res.data);
                        modules.parameters = res.data.Parameters;
                        this.log.info(
                            `Found ${res.data.Parameters.length} parameters for ${device.Name} - ${modules.Name} (${modules.Type})`,
                        );
                        this.json2iob.parse(
                            device.ID + "." + modules.Index + "-" + modules.Type + ".parameters",
                            res.data,
                            {
                                preferedArrayDesc: "Name",
                                preferedArrayName: "ParameterID",
                                channelName: "Parameters of the Module",
                            },
                        );
                    })
                    .catch((error) => {
                        this.log.error(`Failed for ${device.Name} - ${modules.Name} (${modules.Type})`);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
    }
    async getAppStatus() {
        let requestData = {};
        for (const device of this.deviceArray) {
            requestData = { DeviceID: device.ID, Modules: [] };
            for (const modules of device.Modules) {
                if (modules.Name.trim() === "System" || modules.Name.trim() === "Test") {
                    continue;
                }
                const moduleObject = { ModuleType: modules.Type, ModuleIndex: modules.Index, Parameters: [] };

                for (const parameter of modules.parameters) {
                    this.log.debug(
                        `Fetch Status for ${device.Name} - ${modules.Name} (${modules.Type}) - ${parameter.Name}`,
                    );
                    moduleObject.Parameters.push({ ParameterID: parameter.ParameterID });
                }
                if (moduleObject.Parameters.length > 0) {
                    requestData.Modules.push(moduleObject);
                }
            }
            this.log.debug(JSON.stringify(requestData));
            //Refresh
            await this.requestClient({
                method: "post",
                url: "https://www.wemportal.com/app/DataAccess/Refresh",
                headers: {
                    Host: "www.wemportal.com",
                    "Content-Type": "application/json",
                    "X-Api-Version": "2.0.0.0",
                    Accept: "application/json",
                    "User-Agent": "WeishauptWEMApp",
                    "Accept-Language": "de-de",
                    Connection: "keep-alive",
                },
                data: requestData,
            })
                .then((res) => {
                    this.log.debug(res.data);
                })
                .catch((error) => {
                    this.log.error(`App Failed to Refresh`);
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                });
            //Read
            await this.requestClient({
                method: "post",
                maxBodyLength: Infinity,
                url: "https://www.wemportal.com/app/DataAccess/Read",
                headers: {
                    Host: "www.wemportal.com",
                    "Content-Type": "application/json",
                    "X-Api-Version": "2.0.0.0",
                    Accept: "application/json",
                    "User-Agent": "WeishauptWEMApp",
                    "Accept-Language": "de-de",
                    Connection: "keep-alive",
                },
                data: requestData,
            })
                .then((res) => {
                    this.log.debug(res.data);
                    for (const modules of res.data.Modules) {
                        this.json2iob.parse(
                            device.ID + "." + modules.ModuleIndex + "-" + modules.ModuleType + ".parameters",
                            modules.Values,
                            { write: true, preferedArrayName: "ParameterID" },
                        );
                    }
                })
                .catch((error) => {
                    this.log.error(`App Failed to Read`);
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                });
        }
    }

    async login() {
        await this.requestClient({
            method: "get",

            url: "https://www.wemportal.com/Web/Login.aspx",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",

                "Accept-Language": "de,en;q=0.9",
            },
        })
            .then(async (resp) => {
                const dom = new JSDOM(resp.data);
                const form = {};
                for (const formElement of dom.window.document.querySelectorAll("input")) {
                    if (formElement.type === "hidden") {
                        form[formElement.name] = formElement.value;
                    }
                }
                form["ctl00$content$tbxUserName"] = this.config.user;
                form["ctl00$content$tbxPassword"] = this.config.password;
                form["ctl00$content$btnLogin"] = "Anmelden";
                await this.requestClient({
                    method: "post",
                    url: "https://www.wemportal.com/Web/Login.aspx",
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
                        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                        "Accept-Language": "de,en;q=0.9",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data: form,
                    withCredentials: true,
                })
                    .then((resp) => {
                        this.log.debug(resp.data);
                        if (resp.data.indexOf("ctl00_btnLogout") !== -1) {
                            this.log.info("Login successful");
                            this.setState("info.connection", true, true);
                            return;
                        } else {
                            this.log.error("Login failed");
                        }
                    })
                    .catch((error) => {
                        this.log.error(error);
                        error.resp && this.log.error(error.resp.data);
                    });
            })
            .catch((error) => {
                this.log.error(error);
                error.resp && this.log.error(error.resp.data);
            });
    }
    async switchFachmann() {
        await this.requestClient({
            method: "get",
            url: "https://www.wemportal.com/Web/Default.aspx",
            headers: {
                "Accept-Language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6",
                "Accept-Encoding": "gzip, deflate, br",
                "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36",
                Accept: "*/*",
            },
            withCredentials: true,
        })
            .then(async (resp) => {
                const body = resp.data;
                const dpStart = body.indexOf("DataPointId=") + 12;
                const dpEnd = body.indexOf("&", dpStart);
                this.dataPointId = parseInt(body.substring(dpStart, dpEnd));
                if (isNaN(this.dataPointId)) {
                    this.log.info("No dataPointid found maybe remote command are not working use customBefehl");
                }
                const dom = new JSDOM(body);
                const form = {};
                for (const formElement of dom.window.document.querySelectorAll("input")) {
                    if (formElement.type === "hidden") {
                        //form += formElement.name + "=" + formElement.value + "&";
                        form[formElement.name] = formElement.value;
                    }
                }
                form["__EVENTTARGET"] = "ctl00$SubMenuControl1$subMenu";
                form["__EVENTARGUMENT"] = "3";
                form["ctl00_SubMenuControl1_subMenu_ClientState"] =
                    '{"logEntries":[{"Type":3},{"Type":1,"Index":"0","Data":{"text":"Übersicht","value":"110"}},{"Type":1,"Index":"1","Data":{"text":"Anlage:","value":""}},{"Type":1,"Index":"2","Data":{"text":"Benutzer","value":"222"}},{"Type":1,"Index":"3","Data":{"text":"Fachmann","value":"223","selected":true}},{"Type":1,"Index":"4","Data":{"text":"Statistik","value":"225"}},{"Type":1,"Index":"5","Data":{"text":"Datenlogger","value":"224"}}],"selectedItemIndex":"3"}';
                await this.requestClient({
                    method: "post",
                    url: "https://www.wemportal.com/Web/Default.aspx",
                    headers: {
                        "Accept-Language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6",
                        "Accept-Encoding": "gzip, deflate, br",
                        "User-Agent":
                            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36",
                        Accept: "*/*",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    withCredentials: true,
                    maxRedirects: 0,
                    data: form,
                })
                    .then((resp) => {
                        const body = resp.data;

                        this.log.debug(body);

                        this.log.error("Switch to Fachmann failed");
                    })
                    .catch((error) => {
                        if (error.response.status === 302) {
                            this.log.info("Switched to Fachmann");
                            return true;
                        }
                        this.log.error("Switch to Fachmann failed");
                        this.log.error(error);
                        error.resp && this.log.error(error.resp.data);
                    });
            })
            .catch((error) => {
                this.log.error(error);
                error.resp && this.log.error(error.resp.data);
            });
    }

    async switchState(url, value, baseValue) {
        await this.requestClient({
            method: "get",
            url: url,
            headers: {
                "Accept-Language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6",
                "Accept-Encoding": "gzip, deflate, br",
                "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36",
                Accept: "*/*",
            },
            withCredentials: true,
        })
            .then(async (resp) => {
                const body = resp.data;

                this.log.debug(body);
                const dom = new JSDOM(body);
                let form = {};

                for (const formElement of dom.window.document.querySelectorAll("input")) {
                    if (formElement.type === "hidden") {
                        form[formElement.name] = formElement.value;
                    }
                }
                let state = 0; // Standby
                if (baseValue) {
                    state = baseValue;
                }
                state += value;
                let valueID = "ctl00$DialogContent$ddlNewValue";
                if (
                    dom.window.document.querySelector(".ParameterDetailNewValue") &&
                    dom.window.document.querySelector(".ParameterDetailNewValue").id
                ) {
                    valueID = dom.window.document.querySelector(".ParameterDetailNewValue").name;
                }
                form[valueID] = state;
                form["ctl00$TSMeControlNetDialog"] =
                    "ctl00$ctl00$DialogContent$DivDialogPanel|ctl00$DialogContent$BtnSave";
                form["__EVENTTARGET"] = "ctl00$DialogContent$BtnSave";
                await this.requestClient({
                    method: "post",
                    url: url,
                    headers: {
                        "Accept-Language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6",
                        "Accept-Encoding": "gzip, deflate, br",
                        "User-Agent":
                            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36",
                        Accept: "*/*",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    withCredentials: true,
                    data: form,
                })
                    .then((resp) => {
                        const body = resp.data;

                        try {
                            if (body.includes('moved to <a href="/Web/Login.aspx"')) {
                                this.log.error("Login expired");
                            }
                            this.log.debug(body);
                        } catch (error) {
                            this.log.error("Post Receive Error");
                            this.log.error(body);
                            this.log.error(error);
                        }
                    })
                    .catch((error) => {
                        this.log.error(error);
                        error.resp && this.log.error(error.resp.data);
                    });
            })
            .catch((error) => {
                this.log.error(error);
                error.resp && this.log.error(error.resp.data);
            });
    }
    async getStatus() {
        this.log.debug("getHomesStatus");
        await this.requestClient({
            method: "get",
            url: "https://www.wemportal.com/Web/Default.aspx",
            headers: {
                "Accept-Language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6",
                "Accept-Encoding": "gzip, deflate, br",
                "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36",
                Accept: "*/*",
            },
            withCredentials: true,
        })
            .then(async (resp) => {
                const body = resp.data;

                try {
                    const dom = new JSDOM(body);
                    let statusCount = 0;
                    const form = {};

                    const deviceInfo = dom.window.document.querySelector(".DeviceInfo").textContent.replace(/\./g, "");
                    this.log.debug(deviceInfo);
                    this.setObjectNotExists(deviceInfo, {
                        type: "device",
                        common: {
                            name: deviceInfo,
                            role: "indicator",
                            type: "mixed",
                            write: false,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote", {
                        type: "state",
                        common: {
                            name: "Steuerung der Anlage",
                            role: "indicator",
                            type: "mixed",
                            write: false,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote.Systembetriebsart", {
                        type: "state",
                        common: {
                            name: "Systembetriebsart 0 Aus, 1 Standby, 2 Sommer, 3 Auto",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote.Heizkreisbetriebsart", {
                        type: "state",
                        common: {
                            name: "Systembetriebsart 0 Standby, 1 Zeit 1, 2 Zeit 2, ...",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote.Pumpebetriebsart", {
                        type: "state",
                        common: {
                            name: "Pumpebetriebsart 0 Leistungs, 4 Volumen, 5 Prop 1, ...",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote.RaumKomfortTemp", {
                        type: "state",
                        common: {
                            name: "RaumKomfortTemp",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    this.setObjectNotExists(deviceInfo + ".remote.RaumNormalTemp", {
                        type: "state",
                        common: {
                            name: "RaumNormalTemp",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    this.setObjectNotExists(deviceInfo + ".remote.RaumAbsenkTemp", {
                        type: "state",
                        common: {
                            name: "RaumAbsenkTemp",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    this.setObjectNotExists(deviceInfo + ".remote.WWSollNormal", {
                        type: "state",
                        common: {
                            name: "WWSollNormal",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    this.setObjectNotExists(deviceInfo + ".remote.WWSollAbsenk", {
                        type: "state",
                        common: {
                            name: "WWSollAbsenk",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    this.setObjectNotExists(deviceInfo + ".remote.WWPush", {
                        type: "state",
                        common: {
                            name: "WWPush",
                            role: "indicator",
                            type: "number",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });

                    this.setObjectNotExists(deviceInfo + ".remote.CustomBefehl", {
                        type: "state",
                        common: {
                            name: "Eingabe: https://www.wemportal.com/Web/UControls..., 208557",
                            role: "indicator",
                            type: "mixed",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                    const status = dom.window.document.querySelector(
                        "#ctl00_DeviceContextControl1_DeviceStatusText",
                    ).textContent;
                    this.setObjectNotExistsAsync(deviceInfo + ".OnlineStatus", {
                        type: "state",
                        common: {
                            name: "Status",
                            role: "indicator",
                            type: "mixed",
                            write: false,
                            read: true,
                        },
                        native: {},
                    }).then(() => {
                        this.setState(deviceInfo + ".OnlineStatus", status, true);
                    });

                    for (const dataCell of dom.window.document.querySelectorAll(".simpleDataIconCell")) {
                        if (dataCell.nextSibling) {
                            const label = dataCell.nextElementSibling.textContent.trim().replace(/\./g, "");
                            let labelWoSpaces = label.replace(/ /g, "");
                            let value = dataCell.nextElementSibling.nextElementSibling.textContent.trim();

                            let valueArray = value.split(" ");
                            if (valueArray.length === 1) {
                                valueArray = value.split("m");
                                if (valueArray[1]) {
                                    valueArray[1] = "m" + valueArray[1];
                                }
                            }
                            valueArray[0] = valueArray[0].replace(",", ".");
                            let unit = "";
                            if (!isNaN(valueArray[0])) {
                                value = parseFloat(valueArray[0]);
                            }
                            if (valueArray[1]) {
                                unit = valueArray[1];
                            }
                            if (labelWoSpaces === "Status") {
                                labelWoSpaces = labelWoSpaces + statusCount;
                                statusCount++;
                            }
                            this.log.debug(`Found ${label} with value ${value} and unit ${unit} `);
                            this.setObjectNotExistsAsync(deviceInfo + "." + labelWoSpaces, {
                                type: "state",
                                common: {
                                    name: label,
                                    role: "indicator",
                                    type: "mixed",
                                    write: false,
                                    read: true,
                                    unit: unit,
                                },
                                native: {},
                            }).then(() => {
                                this.setState(deviceInfo + "." + labelWoSpaces, value, true);
                            });
                        }
                    }
                } catch (error) {
                    this.log.error(error);
                    this.log.error(error.stack);
                    this.log.debug(body);
                    this.log.error("Not able to parse device name and status try to relogin");
                    this.setState("info.connection", false, true);
                    await this.login();
                    this.log.debug("Login successful");
                    this.setState("info.connection", true, true);
                    await this.switchFachmann();
                    await this.getStatus();
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.resp && this.log.error(error.resp.statusCode);
            });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info("cleaned everything up...");

            // clearInterval(this.refreshTokenInterval);
            clearInterval(this.updateInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                // const deviceId = id.split(".")[2];
                if (id.indexOf("remote") !== -1) {
                    const action = id.split(".")[4];

                    if (action === "Systembetriebsart") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=0600000000000000008000b9ef0100110003&readdata=False&rwndrnd=0.20391030307588598",
                                state.val,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23383&entityvalueid=208560&unit=&entitytype=VarChar&entityvalue=@@wh-597-EV-Repl-14-29&GroupId=54528&ElsterDataType=5&name=@@wh-597-ET-Name-14&OVIndex=9758&DataPointId=" +
                                    this.dataPointId +
                                    "&rwndrnd=0.8080932382276982",
                                state.val,
                                208557,
                            );
                        }
                    }
                    if (action === "Heizkreisbetriebsart") {
                        if (isNaN(this.dataPointId)) {
                            this.log.info("Option is not available");
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23751&entityvalueid=209322&unit=&entitytype=VarChar&entityvalue=@@wh-603-EV-Repl-7-351&GroupId=55012&ElsterDataType=64&name=@@wh-603-ET-Name-7&OVIndex=9523&DataPointId=" +
                                    (this.dataPointId + 1) +
                                    "&rwndrnd=0.7505293487695444",
                                state.val,
                                209321,
                            );
                        }
                    }
                    if (action === "RaumKomfortTemp") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=320019010000CD00D24000B9EF0300110104&readdata=True&rwndrnd=0.7551314485659901",
                                state.val * 10,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23764&entityvalueid=209347&unit=@@wh-Unit-1&entitytype=Float&entityvalue=25&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-14&OVIndex=9531&DataPointId=" +
                                    (this.dataPointId + 1) +
                                    "&rwndrnd=0.5645296482835123",
                                state.val,
                            );
                        }
                    }
                    if (action === "RaumNormalTemp") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=3200190200011800D24000B9EF0300110104&readdata=True&rwndrnd=0.8885759157701352",
                                state.val * 10,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23765&entityvalueid=209348&unit=@@wh-Unit-1&entitytype=Float&entityvalue=21&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-13&OVIndex=9530&DataPointId=" +
                                    (this.dataPointId + 1) +
                                    "&rwndrnd=0.6349659495670719",
                                state.val,
                            );
                        }
                    }

                    if (action === "RaumAbsenkTemp") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=320019030000A000CD4000B9EF0300110104&readdata=True&rwndrnd=0.33021604398910664",
                                state.val * 10,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23766&entityvalueid=209349&unit=@@wh-Unit-1&entitytype=Float&entityvalue=17&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-12&OVIndex=9529&DataPointId=" +
                                    (this.dataPointId + 1) +
                                    "&rwndrnd=0.19101872272453302",
                                state.val,
                            );
                        }
                    }
                    if (action === "WWSollNormal") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=46004201000037003C4000B9EF0300110104&readdata=True&rwndrnd=0.2514459684152772",
                                state.val * 10,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22686&entityvalueid=207552&unit=@@wh-Unit-1&entitytype=Float&entityvalue=50&GroupId=53494&ElsterDataType=68&name=@@wh-582-ET-Name-5&OVIndex=9529&DataPointId=" +
                                    (this.dataPointId + 2) +
                                    "&rwndrnd=0.6669689557062952",
                                state.val,
                            );
                        }
                    }
                    if (action === "WWSollAbsenk") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=4600420200003200374000B9EF0300110104&readdata=True&rwndrnd=0.8895149497674137",
                                state.val * 10,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22687&entityvalueid=207553&unit=@@wh-Unit-1&entitytype=Float&entityvalue=40&GroupId=53494&ElsterDataType=68&name=@@wh-582-ET-Name-6&OVIndex=9528&DataPointId=" +
                                    (this.dataPointId + 2) +
                                    "&rwndrnd=0.9772733556889273",
                                state.val,
                            );
                        }
                    }
                    if (action === "WWPush") {
                        if (isNaN(this.dataPointId)) {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/WwpsParameterDetails.aspx?entityvalue=4600410000000000008000B9EF0200110004&readdata=False&rwndrnd=0.514766269441187",
                                state.val,
                            );
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22688&entityvalueid=207554&unit=&entitytype=Int&entityvalue=0&GroupId=53496&ElsterDataType=64&name=@@wh-582-ET-Name-8&OVIndex=9545&DataPointId=" +
                                    (this.dataPointId + 2) +
                                    "&rwndrnd=0.5910648822562681",
                                state.val,
                            );
                        }
                    }
                    if (action === "Pumpebetriebsart") {
                        if (isNaN(this.dataPointId)) {
                            this.log.info("Option is not available");
                        } else {
                            this.switchState(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=24723&entityvalueid=210505&unit=&entitytype=VarChar&entityvalue=@@wh-613-EV-Repl-53-650&GroupId=55351&ElsterDataType=64&name=@@wh-613-ET-Name-53&OVIndex=9834&DataPointId=" +
                                    (this.dataPointId + 5) +
                                    "&rwndrnd=0.3333835266610612",
                                state.val,
                                210496,
                            );
                        }
                    }
                    if (action === "CustomBefehl") {
                        try {
                            const pArray = state.val.replace(/ /g, "").split(",");
                            if (isNaN(pArray[1])) {
                                this.log.debug(pArray[1] + " is  not a number");
                            }
                            if (pArray[0].includes("wemportal.de/")) {
                                this.log.error("Please use wemportal.com portal");
                                return;
                            }
                            this.switchState(pArray[0], parseFloat(pArray[1]));
                        } catch (error) {
                            this.log.error("No valid custom befehl. Example: ");
                            this.log.error(
                                "https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22686&entityvalue...., 52",
                            );
                        }
                    }
                }
                if (id.indexOf(".parameters.") !== -1) {
                    const deviceId = id.split(".")[2];
                    const modulesId = id.split(".")[3];
                    const moduleIndex = modulesId.split("-")[0];
                    const moduleType = modulesId.split("-")[1];
                    const parameterId = id.split(".")[5];
                    const parameterType = id.split(".")[6];
                    const requestData = {
                        DeviceID: deviceId,
                        Modules: [
                            {
                                ModuleIndex: moduleIndex,
                                ModuleType: moduleType,
                                Parameters: [
                                    {
                                        NumericValue: null,
                                        ParameterID: parameterId,
                                        StringValue: "",
                                    },
                                ],
                            },
                        ],
                    };

                    if (parameterType === "NumericValue") {
                        requestData.Modules[0].Parameters[0].NumericValue = state.val;
                    } else {
                        requestData.Modules[0].Parameters[0].StringValue = state.val;
                    }
                    await this.requestClient({
                        method: "post",
                        maxBodyLength: Infinity,
                        url: "https://www.wemportal.com/app/DataAccess/Write",
                        headers: {
                            Host: "www.wemportal.com",
                            "Content-Type": "application/json",
                            "X-Api-Version": "2.0.0.0",

                            Accept: "application/json",
                            "User-Agent": "WeishauptWEMApp",
                            "Accept-Language": "de-de",
                            Connection: "keep-alive",
                        },
                        data: requestData,
                    })
                        .then((response) => {
                            this.log.info(JSOn.stringify(response.data));
                        })
                        .catch((error) => {
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        });
                }
            }
        } else {
            // The state was deleted
            //	this.log.info(`state ${id} deleted`);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new WeishauptWem(options);
} else {
    // otherwise start the instance directly
    new WeishauptWem();
}
