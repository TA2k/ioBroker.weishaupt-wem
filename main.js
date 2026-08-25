"use strict";

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

//disable canvas because of missing rebuild
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function () {
    if (arguments[0] === "canvas") {
        // Make jsdom believe canvas is not installed so it uses its built-in
        // graceful fallback. Returning a partial stub object breaks newer jsdom
        // (>=22), which then calls `new Canvas.Image()` -> "Canvas.Image is not a
        // constructor". We do not need any canvas/image rendering for HTML scraping.
        const error = new Error("Cannot find module 'canvas'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
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
        // Timestamp until which we skip all portal requests after a 403.
        // The WEM portal (Azure Application Gateway) rate-limits/bans the IP on
        // request bursts. The 403 carries no Retry-After header, so we use a fixed
        // backoff. The observed cooldown is ~1-2 min; 5 min is a safe margin that
        // still resumes within a normal poll cycle.
        this.blockedUntil = 0;
        this.backoffMs = 5 * 60 * 1000;
        // Statistics are heavy; only fetch once per hour.
        this.lastStatisticsFetch = 0;
        this.apiVersion = null;
        this.json2iob = new json2iob(this);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        this.setState("info.connection", false, true);
        // Reset the connection indicator during startup

        // The WEM portal is served under different regional domains (.com / .de).
        // Allow the user to select the one their account is served under, default to .com.
        this.baseUrl = this.config.baseUrl || "https://www.wemportal.com";
        try {
            this.host = new URL(this.baseUrl).host;
        } catch (e) {
            this.log.warn(
                `Invalid baseUrl "${this.baseUrl}" (${e.message}), falling back to https://www.wemportal.com`,
            );
            this.baseUrl = "https://www.wemportal.com";
            this.host = "www.wemportal.com";
        }
        this.log.info(`Using WEM portal: ${this.baseUrl}`);

        try {
            await this.login();
            this.log.debug("Start first switchFachmann");
            await this.switchFachmann();
            await this.getStatus();
            if (this.config.useApp) {
                this.log.info("Start App Login");
                const isLoggedInApp = await this.loginApp();
                if (isLoggedInApp) {
                    this.log.info("App Login successful");
                    await this.getAppDevices();
                    await this.getParameters();
                    await this.getAppStatus();
                }
            }
        } catch (error) {
            this.log.error("Initialization failed, will retry on the next interval");
            this.log.error(error);
        }
        this.updateInterval = setInterval(() => {
            this.getStatus().catch((error) => this.log.error(error));

            if (this.config.useApp) {
                this.getAppStatus().catch((error) => this.log.error(error));
            }
        }, this.config.interval * 60 * 1000);

        this.refreshTokenInterval = setInterval(() => {
            this.loginApp().catch((error) => this.log.error(error));
        }, 3 * 60 * 60 * 1000);

        this.subscribeStates("*");
    }

    /**
     * Build the standard app API headers. Values verified against the Weishaupt
     * app APK v3.0.1 (de.weishaupt.wemapp NetworkModule interceptor):
     * User-Agent WeishauptWEMApp, Accept application/json, X-Api-Version 2.0.0.0.
     * Pass `extra` to override single headers.
     */
    buildApiHeaders(extra) {
        return Object.assign(
            {
                "User-Agent": "WeishauptWEMApp",
                "X-Api-Version": "2.0.0.0",
                Accept: "application/json",
                Host: this.host,
                "Content-Type": "application/json",
                "Accept-Language": "de-de",
                Connection: "keep-alive",
            },
            extra || {},
        );
    }

    /**
     * Centralized app API call. Throttles every request (portal rate-limits bursts),
     * detects a stealthy session expiry (200 with the HTML login page), retries once
     * after a re-login on 401/expiry, and starts a backoff window on 403.
     * Returns the axios response, or null on failure.
     */
    async apiRequest(url, data, options = {}) {
        const { headers, retry = true, delay = 1000 } = options;
        if (this.isBackedOff("apiRequest")) {
            return null;
        }
        await this.sleep(delay);
        try {
            const resp = await this.requestClient({
                method: data ? "post" : "get",
                maxBodyLength: Infinity,
                url,
                headers: this.buildApiHeaders(headers),
                data: data || undefined,
            });
            const finalUrl = resp.request && resp.request.res && resp.request.res.responseUrl;
            if (
                (finalUrl && finalUrl.indexOf("Account/Login") !== -1) ||
                (typeof resp.data === "string" && resp.data.indexOf("Account/Login") !== -1)
            ) {
                throw { expiredSession: true };
            }
            return resp;
        } catch (error) {
            const status = error.response && error.response.status;
            if (status === 403) {
                this.handle403(error);
                return null;
            }
            if ((error.expiredSession || status === 401) && retry) {
                this.log.info(`Session expired for ${url}, re-login and retry once`);
                const ok = await this.loginApp();
                if (!ok) {
                    return null;
                }
                await this.sleep(5000);
                return await this.apiRequest(url, data, { ...options, retry: false });
            }
            this.log.error(`App request failed: ${url}`);
            this.log.error(error.message || error);
            error.response && this.log.error(JSON.stringify(error.response.data));
            return null;
        }
    }

    async loginApp() {
        if (this.isBackedOff("loginApp")) {
            return false;
        }
        await this.sleep(1000);
        return await this.requestClient({
            method: "post",
            maxBodyLength: Infinity,
            url: `${this.baseUrl}/app/Account/Login`,
            headers: this.buildApiHeaders(),
            data: {
                Name: this.config.user,
                PasswordUTF8: this.config.password,
                AppID: "de.weishaupt.wemapp",
                AppVersion: "3.0.1",
                ClientOS: "Android",
            },
        })
            .then((resp) => {
                this.log.debug(resp.data);
                if (resp && resp.data && resp.data.Status === 0) {
                    this.apiVersion = resp.data.Version;
                    return true;
                }
                this.log.error(JSON.stringify(resp.data));
                this.log.error("App Login failed");
                return false;
            })
            .catch((error) => {
                if (this.handle403(error)) {
                    return false;
                }
                this.log.error(error);
                error.response && this.log.error(error.response.data);
                return false;
            });
    }
    async getAppDevices() {
        const res = await this.apiRequest(`${this.baseUrl}/app/Device/Read`);
        if (!res) {
            return;
        }
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
    }
    /**
     * Read device connection status and error list (app/DeviceStatus/Read).
     * Returns true if the device is online.
     */
    async getDeviceStatus(device) {
        const res = await this.apiRequest(`${this.baseUrl}/app/DeviceStatus/Read`, { DeviceID: device.ID });
        if (!res) {
            return true; // unknown, keep polling
        }
        const data = res.data;
        const statusMap = { 0: "online", 7: "wrong_secret", 8: "busy", 50: "offline" };
        const connStatus = statusMap[data.ConnectionStatus] || "unknown";
        const errors = Array.isArray(data.Errors) ? data.Errors : [];
        await this.setObjectNotExistsAsync(device.ID + ".status", {
            type: "channel",
            common: { name: "Device status" },
            native: {},
        });
        const statusStates = {
            ConnectionStatus: connStatus,
            HasErrors: errors.length > 0,
            ErrorMessages: errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(", "),
        };
        for (const [key, value] of Object.entries(statusStates)) {
            await this.setObjectNotExistsAsync(device.ID + ".status." + key, {
                type: "state",
                common: {
                    name: key,
                    role: "indicator",
                    type: typeof value === "boolean" ? "boolean" : "mixed",
                    write: false,
                    read: true,
                },
                native: {},
            });
            this.setState(device.ID + ".status." + key, value, true);
        }
        if (connStatus !== "online") {
            this.log.warn(`Device ${device.Name} is ${connStatus}`);
        }
        return connStatus === "online";
    }
    async getParameters() {
        if (this.isBackedOff("getParameters")) {
            return;
        }
        for (const device of this.deviceArray) {
            for (const modules of device.Modules) {
                this.log.debug(`App Fetch Status for ${device.Name} - ${modules.Name} (${modules.Type})`);
                if (modules.Name === "System " || modules.Name === "Test") {
                    continue;
                }
                const res = await this.apiRequest(`${this.baseUrl}/app/EventType/Read`, {
                    DeviceID: device.ID,
                    ModuleType: modules.Type,
                    ModuleIndex: modules.Index,
                });
                if (!res) {
                    if (Date.now() < this.blockedUntil) {
                        // Rate limited; stop and let the backoff window pass.
                        return;
                    }
                    continue;
                }
                modules.parameters = res.data.Parameters;
                this.log.info(
                    `Found ${res.data.Parameters.length} parameters for ${device.Name} - ${modules.Name} (${modules.Type})`,
                );
                this.json2iob.parse(device.ID + "." + modules.Index + "-" + modules.Type + ".parameters", res.data, {
                    preferedArrayDesc: "Name",
                    preferedArrayName: "ParameterID",
                    channelName: "Parameters of the Module",
                });
            }
        }
    }
    /**
     * Fetch heating schedules for parameters of type PROGRAM (DataType === 6),
     * via app/CircuitTimes/Refresh + Read.
     */
    async getCircuitTimes(device) {
        if (!this.modulesHaveParameters(device)) {
            return;
        }
        for (const modules of device.Modules) {
            if (!Array.isArray(modules.parameters)) {
                continue;
            }
            for (const parameter of modules.parameters) {
                if (parameter.DataType !== 6) {
                    continue;
                }
                const refresh = await this.apiRequest(`${this.baseUrl}/app/CircuitTimes/Refresh`, {
                    DeviceID: device.ID,
                    ModuleIndex: modules.Index,
                    ModuleType: modules.Type,
                    ParameterID: parameter.ParameterID,
                });
                if (!refresh || refresh.data.JobID == null) {
                    continue;
                }
                await this.sleep(2000);
                const schedule = await this.apiRequest(`${this.baseUrl}/app/CircuitTimes/Read`, {
                    DeviceID: device.ID,
                    JobID: refresh.data.JobID,
                    ModuleIndex: modules.Index,
                    ModuleType: modules.Type,
                    ParameterID: parameter.ParameterID,
                });
                if (!schedule) {
                    continue;
                }
                const ctBase =
                    device.ID + "." + modules.Index + "-" + modules.Type + ".circuitTimes." + parameter.ParameterID;
                this.json2iob.parse(ctBase, schedule.data, {
                    channelName: "Heating schedule for " + parameter.ParameterID,
                });
                // Writable state: paste the edited schedule JSON here to send it back
                // via CircuitTimes/Write. Prefilled with the current schedule.
                await this.setObjectNotExistsAsync(ctBase + ".setSchedule", {
                    type: "state",
                    common: {
                        name: "Write schedule (JSON with Type, PossibleValues, CircuitTimesDay)",
                        role: "json",
                        type: "string",
                        write: true,
                        read: true,
                    },
                    native: {},
                });
                this.setState(
                    ctBase + ".setSchedule",
                    JSON.stringify({
                        Type: schedule.data.Type,
                        PossibleValues: schedule.data.PossibleValues,
                        CircuitTimesDay: schedule.data.CircuitTimesDay,
                    }),
                    true,
                );
            }
        }
    }
    /**
     * Write a heating schedule back to the portal (app/CircuitTimes/Write).
     * `id` is the .setSchedule state id, `val` the edited schedule JSON
     * ({ Type, PossibleValues, CircuitTimesDay }). Verified against APK v3.0.1.
     */
    async writeCircuitTimes(id, val) {
        try {
            const parts = id.split(".");
            const ctIdx = parts.indexOf("circuitTimes");
            const deviceId = parts[2];
            const moduleId = parts[3];
            const moduleIndex = parseInt(moduleId.split("-")[0]);
            const moduleType = parseInt(moduleId.split("-")[1]);
            const parameterId = parts[ctIdx + 1];
            const circuitTimes = typeof val === "string" ? JSON.parse(val) : val;
            const requestData = {
                DeviceID: parseInt(deviceId),
                ModuleType: moduleType,
                ModuleIndex: moduleIndex,
                ParameterID: parameterId,
                CircuitTimes: {
                    Type: circuitTimes.Type,
                    PossibleValues: circuitTimes.PossibleValues,
                    CircuitTimesDay: circuitTimes.CircuitTimesDay,
                },
            };
            const res = await this.apiRequest(`${this.baseUrl}/app/CircuitTimes/Write`, requestData);
            if (res) {
                this.log.info(`CircuitTimes written for ${parameterId}: ${JSON.stringify(res.data)}`);
            }
        } catch (error) {
            this.log.error(
                "Failed to write CircuitTimes. Expected JSON with { Type, PossibleValues, CircuitTimesDay }",
            );
            this.log.error(error.message || error);
        }
    }
    modulesHaveParameters(device) {
        return device.Modules.some((m) => Array.isArray(m.parameters) && m.parameters.length > 0);
    }
    /**
     * Fetch historical energy statistics (app/Statistics/Refresh + Read).
     * Rate limited to once per hour, mirroring hass-WEM-Portal.
     */
    async getStatistics() {
        const now = Date.now();
        if (now - this.lastStatisticsFetch < 60 * 60 * 1000) {
            return;
        }
        this.lastStatisticsFetch = now;
        for (const device of this.deviceArray) {
            const refresh = await this.apiRequest(`${this.baseUrl}/app/Statistics/Refresh`, { DeviceID: device.ID });
            if (!refresh) {
                continue;
            }
            const groups = refresh.data.GroupTypeDescriptions || [];
            for (const group of groups) {
                const groupId = group.GroupType;
                const stats = await this.apiRequest(`${this.baseUrl}/app/Statistics/Read`, {
                    DeviceID: device.ID,
                    ModuleType: 7,
                    ModuleIndex: 0,
                    GroupType: groupId,
                    Type: 1,
                });
                if (!stats) {
                    continue;
                }
                const values = stats.data.Values || [];
                if (!values.length) {
                    continue;
                }
                const latest = values[values.length - 1];
                const id = device.ID + ".statistics.Energy_" + groupId;
                await this.setObjectNotExistsAsync(id, {
                    type: "state",
                    common: {
                        name: group.Description || "Energy " + groupId,
                        role: "value.power.consumption",
                        type: "number",
                        unit: stats.data.Unit || "kWh",
                        write: false,
                        read: true,
                    },
                    native: {},
                });
                this.setState(id, latest.Value != null ? latest.Value : 0, true);
            }
        }
    }
    async getAppStatus() {
        if (this.isBackedOff("getAppStatus")) {
            return;
        }
        let requestData;
        for (const device of this.deviceArray) {
            await this.getDeviceStatus(device);
            requestData = { DeviceID: device.ID, Modules: [] };
            for (const modules of device.Modules) {
                if (modules.Name.trim() === "System" || modules.Name.trim() === "Test") {
                    continue;
                }
                const moduleObject = { ModuleType: modules.Type, ModuleIndex: modules.Index, Parameters: [] };

                if (!Array.isArray(modules.parameters)) {
                    this.log.debug(
                        `No parameters loaded for ${device.Name} - ${modules.Name} (${modules.Type}), skipping`,
                    );
                    continue;
                }
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
            if (requestData.Modules.length === 0) {
                continue;
            }
            //Refresh
            await this.apiRequest(`${this.baseUrl}/app/DataAccess/Refresh`, requestData);
            // Give the backend time to build the refreshed values before reading them.
            await this.sleep(5000);
            //Read
            const res = await this.apiRequest(`${this.baseUrl}/app/DataAccess/Read`, requestData);
            if (res) {
                for (const modules of res.data.Modules) {
                    this.json2iob.parse(
                        device.ID + "." + modules.ModuleIndex + "-" + modules.ModuleType + ".parameters",
                        modules.Values,
                        { write: true, preferedArrayName: "ParameterID" },
                    );
                }
            }
            //Heating schedules
            await this.getCircuitTimes(device);
        }
        //Energy statistics (internally rate limited to once per hour)
        await this.getStatistics();
    }

    async login() {
        this.log.debug("Start Webportal Login");
        if (this.isBackedOff("login")) {
            return;
        }
        await this.requestClient({
            method: "get",

            url: `${this.baseUrl}/Web/Login.aspx`,
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
                this.log.debug(`Received first Form: ${JSON.stringify(form)}`);
                form["ctl00$content$tbxUserName"] = this.config.user;
                form["ctl00$content$tbxPassword"] = this.config.password;
                form["ctl00$content$btnLogin"] = "Anmelden";
                await this.requestClient({
                    method: "post",
                    url: `${this.baseUrl}/Web/Login.aspx`,
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
                        this.log.debug("Received second Form:");
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
                        this.log.error("Failed second Login Step");
                        this.log.error(error);
                        error.resp && this.log.error(error.resp.data);
                    });
            })
            .catch((error) => {
                if (error.response && error.response.status === 403) {
                    this.handle403(error);
                    this.log.error(
                        `First Login Step was rejected with 403 by the Azure gateway of ${this.host}. This is usually IP rate limiting / bot protection, not a wrong password. The adapter now backs off. If you log in manually on a different domain (e.g. www.wemportal.de), also try switching the "WEM Portal Domain" setting.`,
                    );
                } else {
                    this.log.error(
                        `Failed first Login Step. Please check your login on ${this.baseUrl}/Web/Login.aspx`,
                    );
                }
                this.log.warn("Only one device per account is supported");
                this.log.error(error);
                error.resp && this.log.error(error.resp.data);
            });
    }
    async switchFachmann() {
        if (this.isBackedOff("switchFachmann")) {
            return;
        }
        await this.requestClient({
            method: "get",
            url: `${this.baseUrl}/Web/Default.aspx`,
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
                    url: `${this.baseUrl}/Web/Default.aspx`,
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
        // The remote-control URLs are hardcoded against www.wemportal.com. Route them
        // through the configured domain so they also work on regional portals (e.g. .de).
        url = url.replace(/https:\/\/www\.wemportal\.(com|de)/, this.baseUrl);
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
                const form = {};
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
    /**
     * Returns true while we are in a 403 backoff window and should not send requests.
     */
    isBackedOff(context) {
        if (Date.now() < this.blockedUntil) {
            this.log.warn(
                `${context}: skipping request, backing off after 403 until ${new Date(this.blockedUntil).toLocaleString()}`,
            );
            return true;
        }
        return false;
    }

    /**
     * If the error is a 403 from the Azure gateway, start a backoff window and stop hammering.
     * Returns true if a 403 was handled.
     */
    handle403(error) {
        if (error && error.response && error.response.status === 403) {
            this.blockedUntil = Date.now() + this.backoffMs;
            this.setState("info.connection", false, true);
            this.cookieJar.removeAllCookiesSync();
            this.log.warn(
                `Portal returned 403 (Azure gateway rate limit / bot protection). Backing off for ${Math.round(
                    this.backoffMs / 60000,
                )} minutes so the IP can recover. If this repeats, increase the update interval.`,
            );
            return true;
        }
        return false;
    }

    /**
     * Small delay helper. The WEM portal throttles bursts, so we space requests out
     * (pattern taken from the hass-WEM-Portal integration).
     */
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async getStatus() {
        this.log.debug("getHomesStatus");
        if (this.isBackedOff("getStatus")) {
            return;
        }
        await this.requestClient({            method: "get",
            url: `${this.baseUrl}/Web/Default.aspx`,
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
                    if (!dom.window.document.querySelector(".DeviceInfo")) {
                        this.log.info("No Status found");
                        await this.login();
                        await this.switchFachmann();
                        return;
                    }
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
                    this.setObjectNotExists(deviceInfo + ".remote.refresh", {
                        type: "state",
                        common: {
                            name: "Refresh",
                            role: "button",
                            type: "boolean",
                            write: true,
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
                    const statusElement = dom.window.document.querySelector(
                        "#ctl00_DeviceContextControl1_DeviceStatusText",
                    );
                    const status = statusElement ? statusElement.textContent : "";
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
                    this.log.error("Not able to parse device name and status, session likely expired, relogin");
                    this.setState("info.connection", false, true);
                    await this.login();
                    await this.switchFachmann();
                    // Do NOT recurse into getStatus() here: on a persistently failing/blocked
                    // portal that would create a relogin storm and trip the rate limit. The next
                    // scheduled interval fetches fresh data.
                }
            })
            .catch((error) => {
                if (this.handle403(error)) {
                    return;
                }
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

            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
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
                if (id.indexOf(".remote.refresh") !== -1) {
                    this.getStatus();
                    if (this.config.useApp) {
                        this.getAppStatus();
                    }
                } else if (id.indexOf("remote") !== -1) {
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
                        url: `${this.baseUrl}/app/DataAccess/Write`,
                        headers: {
                            Host: this.host,
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
                            this.log.info(JSON.stringify(response.data));
                        })
                        .catch((error) => {
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        });
                }
                if (id.indexOf(".circuitTimes.") !== -1 && id.endsWith(".setSchedule")) {
                    await this.writeCircuitTimes(id, state.val);
                }
                setTimeout(() => {
                    this.getStatus();
                    if (this.config.useApp) {
                        this.getAppStatus();
                    }
                }, 10000);
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
