"use strict";

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");


const request = require("request");
const jsdom = require("jsdom");
const {
	JSDOM
} = jsdom;
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
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));


		this.jar = request.jar();
		this.refreshTokenInterval = null;
		this.updateInterval = null;
		this.dataPointId = 0;

	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		this.setState("info.connection", false, true);
		// Reset the connection indicator during startup
		this.login().then(() => {
			this.log.debug("Login successful");
			this.setState("info.connection", true, true);
			this.switchFachmann().then(() => {
				this.getStatus().then(() => {});
				this.updateInterval = setInterval(() => {
					this.getStatus();
				}, this.config.interval * 60 * 1000)
			})
		});

		this.subscribeStates("*");

	}

	login() {
		return new Promise((resolve, reject) => {
			/*
				
					}
			*/
			request.get({
				url: "https://www.wemportal.com/Web/Login.aspx",
				headers: {
					'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
					'Accept-Encoding': 'gzip, deflate, br',
					'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
					"Accept": "*/*"
				},
				gzip: true,
				jar: this.jar,
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}

				try {
					const dom = new JSDOM(body);
					let form = {};
					for (const formElement of dom.window.document.querySelectorAll("input")) {
						if (formElement.type === "hidden") {
							//form += formElement.name + "=" + formElement.value + "&";
							form[formElement.name] = formElement.value;
						}
					}
					form["ctl00$content$tbxUserName"] = this.config.user;
					form["ctl00$content$tbxPassword"] = this.config.password;
					form["ctl00$content$btnLogin"] = "Anmelden";
					request.post({
						url: "https://www.wemportal.com/Web/Login.aspx",
						headers: {
							'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
							'Accept-Encoding': 'gzip, deflate, br',
							'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
							"Accept": "*/*",
							"Content-Type": "application/x-www-form-urlencoded",
						},
						form: form,
						gzip: true,
						jar: this.jar,
						followAllRedirects: false,
					}, (err, resp, body) => {
						if (err) {
							this.log.error(err);
							reject();
						} else {
							try {
								this.log.debug(body);
								if (body.indexOf('Object moved to <a href="/Web/Default.aspx"') !== -1) {
									resolve()
								}
							} catch (error) {
								this.log.error(error);
								reject();
							}
						}

					});

				} catch (error) {
					this.log.error(error);
					reject();
				}
			});
		});
	}
	switchFachmann() {
		return new Promise((resolve, reject) => {
			request.get({
				url: "https://www.wemportal.com/Web/Default.aspx",
				headers: {
					'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
					'Accept-Encoding': 'gzip, deflate, br',
					'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
					"Accept": "*/*"
				},
				gzip: true,
				jar: this.jar,
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}

				try {

					const dpStart = body.indexOf("DataPointId=") + 12;
					const dpEnd = body.indexOf("&", dpStart);
					this.dataPointId = parseInt(body.substring(dpStart, dpEnd));

					const dom = new JSDOM(body);
					let form = {};
					for (const formElement of dom.window.document.querySelectorAll("input")) {
						if (formElement.type === "hidden") {
							//form += formElement.name + "=" + formElement.value + "&";
							form[formElement.name] = formElement.value;
						}
					}
					form["__EVENTTARGET"] = "ctl00$SubMenuControl1$subMenu";
					form["__EVENTARGUMENT"] = "3";
					form["ctl00_SubMenuControl1_subMenu_ClientState"] = '{"logEntries":[{"Type":3},{"Type":1,"Index":"0","Data":{"text":"Übersicht","value":"110"}},{"Type":1,"Index":"1","Data":{"text":"Anlage:","value":""}},{"Type":1,"Index":"2","Data":{"text":"Benutzer","value":"222"}},{"Type":1,"Index":"3","Data":{"text":"Fachmann","value":"223","selected":true}},{"Type":1,"Index":"4","Data":{"text":"Statistik","value":"225"}},{"Type":1,"Index":"5","Data":{"text":"Datenlogger","value":"224"}}],"selectedItemIndex":"3"}'
					request.post({
						url: "https://www.wemportal.com/Web/Default.aspx",
						headers: {
							'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
							'Accept-Encoding': 'gzip, deflate, br',
							'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
							"Accept": "*/*",
							"Content-Type": "application/x-www-form-urlencoded",
						},
						form: form,
						gzip: true,
						jar: this.jar,
						followAllRedirects: false,
					}, (err, resp, body) => {
						if (err) {
							this.log.error(err);
							reject();
						} else {
							try {
								this.log.debug(body);
								if (body.indexOf('Object moved to <a href="https://www.wemportal.com/Web/Default.aspx"') !== -1) {
									resolve()
								}
							} catch (error) {
								this.log.error(error);
								reject();
							}
						}

					});

				} catch (error) {
					this.log.error(error);
					this.log.error(error.stack);
					reject();
				}
			});
		});
	}

	switchState(url, value, baseValue) {
		return new Promise((resolve, reject) => {
			request.get({
				url: url,
				headers: {
					'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
					'Accept-Encoding': 'gzip, deflate, br',
					'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
					"Accept": "*/*"
				},
				gzip: true,
				jar: this.jar,
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}

				try {
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
					let valueID = "ctl00$DialogContent$ddlNewValue"
					if (dom.window.document.querySelector(".ParameterDetailNewValue") && dom.window.document.querySelector(".ParameterDetailNewValue").id) {
						valueID = dom.window.document.querySelector(".ParameterDetailNewValue").name;
					}
					form[valueID] = state;
					form["ctl00$TSMeControlNetDialog"] = "ctl00$ctl00$DialogContent$DivDialogPanel|ctl00$DialogContent$BtnSave";
					form["__EVENTTARGET"] = "ctl00$DialogContent$BtnSave";
					request.post({
						url: url,
						headers: {
							'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
							'Accept-Encoding': 'gzip, deflate, br',
							'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
							"Accept": "*/*",
							"Content-Type": "application/x-www-form-urlencoded",
						},
						form: form,
						gzip: true,
						jar: this.jar,
						followAllRedirects: false,
					}, (err, resp, body) => {
						if (err) {
							this.log.error(err);
							reject();
						} else {
							try {
								this.log.debug(body);
								resolve();
							} catch (error) {
								this.log.error(error);
								reject();
							}
						}

					});

				} catch (error) {
					this.log.error(error);
					this.log.error(error.stack);
					reject();
				}
			});
		});
	}
	getStatus() {
		return new Promise((resolve, reject) => {
			this.log.debug("getHomesStatus");
			request.get({
				url: "https://www.wemportal.com/Web/Default.aspx",
				headers: {
					'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
					'Accept-Encoding': 'gzip, deflate, br',
					'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
					"Accept": "*/*",

				},
				gzip: true,
				jar: this.jar,
				followAllRedirects: true,

			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}
				try {
					const dom = new JSDOM(body);
					let form = {};
					const deviceInfo = dom.window.document.querySelector(".DeviceInfo").textContent;
					this.setObjectNotExists(deviceInfo, {
						type: "device",
						common: {
							name: deviceInfo,
							role: "indicator",
							type: "mixed",
							write: false,
							read: true
						},
						native: {}
					});

					this.setObjectNotExists(deviceInfo + ".remote", {
						type: "state",
						common: {
							name: "Steuerung der Anlage",
							role: "indicator",
							type: "mixed",
							write: false,
							read: true
						},
						native: {}
					});

					this.setObjectNotExists(deviceInfo + ".remote.Systembetriebsart", {
						type: "state",
						common: {
							name: "Systembetriebsart 0 Aus, 1 Standby, 2 Sommer, 3 Auto",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});


					this.setObjectNotExists(deviceInfo + ".remote.Heizkreisbetriebsart", {
						type: "state",
						common: {
							name: "Systembetriebsart 0 Standby, 1 Zeit 1, 2 Zeit 2, ...",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});

					this.setObjectNotExists(deviceInfo + ".remote.Pumpebetriebsart", {
						type: "state",
						common: {
							name: "Pumpebetriebsart 0 Leistungs, 4 Volumen, 5 Prop 1, ...",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});

					this.setObjectNotExists(deviceInfo + ".remote.RaumKomfortTemp", {
						type: "state",
						common: {
							name: "RaumKomfortTemp",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(deviceInfo + ".remote.RaumNormalTemp", {
						type: "state",
						common: {
							name: "RaumNormalTemp",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(deviceInfo + ".remote.RaumAbsenkTemp", {
						type: "state",
						common: {
							name: "RaumAbsenkTemp",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(deviceInfo + ".remote.WWSollNormal", {
						type: "state",
						common: {
							name: "WWSollNormal",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(deviceInfo + ".remote.WWSollAbsenk", {
						type: "state",
						common: {
							name: "WWSollAbsenk",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(deviceInfo + ".remote.WWPush", {
						type: "state",
						common: {
							name: "WWPush",
							role: "indicator",
							type: "number",
							write: true,
							read: true
						},
						native: {}
					});

					this.setObjectNotExists(deviceInfo + ".remote.CustomBefehl", {
						type: "state",
						common: {
							name: 'Eingabe: https://www.wemportal.com/Web/UControls..., 208557',
							role: "indicator",
							type: "mixed",
							write: true,
							read: true
						},
						native: {}
					});
					const status = dom.window.document.querySelector("#ctl00_DeviceContextControl1_DeviceStatusText").textContent;
					this.setObjectNotExists(deviceInfo + ".status", {
						type: "state",
						common: {
							name: "Status",
							role: "indicator",
							type: "mixed",
							write: false,
							read: true
						},
						native: {}
					});
					this.setState(deviceInfo + ".status", status, true);
					for (const dataCell of dom.window.document.querySelectorAll(".simpleDataIconCell")) {
						if (dataCell.nextSibling) {
							const label = dataCell.nextElementSibling.textContent.trim().replace(/\./g, "");
							let value = dataCell.nextElementSibling.nextElementSibling.textContent.trim()
							this.setObjectNotExists(deviceInfo + "." + label, {
								type: "state",
								common: {
									name: label,
									role: "indicator",
									type: "mixed",
									write: false,
									read: true
								},
								native: {}
							});
							const valueArray = value.split(" ");
							valueArray[0] = valueArray[0].replace(',', '.');
							if (!isNaN(valueArray[0])) {
								value = parseFloat(valueArray[0])
							}
							this.setState(deviceInfo + "." + label, value, true);

						}
					}
					resolve();
				} catch (error) {
					this.log.error(error);
					this.log.error(error.stack);
					this.log.debug(body);
					this.log.error("Not able to parse device name and status try to relogin");
					this.setState("info.connection", false, true);
					this.login().then(() => {
						this.log.debug("Login successful");
						this.setState("info.connection", true, true);
						this.switchFachmann()
					});
					reject();
				}
			});
		});
	}

	setWemState(body) {
		return new Promise((resolve, reject) => {
			request.post({
				url: "",
				headers: {

				},
				body: body,
				json: true,
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}
				try {
					this.log.info(body);
					resolve();

				} catch (error) {
					this.log.error(error);
					reject();
				}
			});
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
	 * Is called if a subscribed object changes
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	onObjectChange(id, obj) {
		if (obj) {
			// The object was changed
			//	this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			//	this.log.info(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			if (!state.ack) {
				// const deviceId = id.split(".")[2];
				if (id.indexOf("remote") !== -1) {
					const action = id.split(".")[4];
					if (action === "Systembetriebsart") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23383&entityvalueid=208560&unit=&entitytype=VarChar&entityvalue=@@wh-597-EV-Repl-14-29&GroupId=54528&ElsterDataType=5&name=@@wh-597-ET-Name-14&OVIndex=9758&DataPointId=" + this.dataPointId + "&rwndrnd=0.8080932382276982", state.val, 208557)
					}
					if (action === "Heizkreisbetriebsart") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23751&entityvalueid=209322&unit=&entitytype=VarChar&entityvalue=@@wh-603-EV-Repl-7-351&GroupId=55012&ElsterDataType=64&name=@@wh-603-ET-Name-7&OVIndex=9523&DataPointId=" + (this.dataPointId + 1) + "&rwndrnd=0.7505293487695444", state.val, 209321)
					}
					if (action === "RaumKomfortTemp") {
						const currentId =  
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23764&entityvalueid=209347&unit=@@wh-Unit-1&entitytype=Float&entityvalue=25&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-14&OVIndex=9531&DataPointId=" + (this.dataPointId + 1) + "&rwndrnd=0.5645296482835123", state.val)
					}
					if (action === "RaumNormalTemp") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23765&entityvalueid=209348&unit=@@wh-Unit-1&entitytype=Float&entityvalue=21&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-13&OVIndex=9530&DataPointId=" + (this.dataPointId + 1) + "&rwndrnd=0.6349659495670719", state.val)
					}
					if (action === "RaumAbsenkTemp") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=23766&entityvalueid=209349&unit=@@wh-Unit-1&entitytype=Float&entityvalue=17&GroupId=55018&ElsterDataType=68&name=@@wh-603-ET-Name-12&OVIndex=9529&DataPointId=" + (this.dataPointId + 1) + "&rwndrnd=0.19101872272453302", state.val)
					}
					if (action === "WWSollNormal") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22686&entityvalueid=207552&unit=@@wh-Unit-1&entitytype=Float&entityvalue=50&GroupId=53494&ElsterDataType=68&name=@@wh-582-ET-Name-5&OVIndex=9529&DataPointId=" + (this.dataPointId + 2) + "&rwndrnd=0.6669689557062952", state.val)
					}
					if (action === "WWSollAbsenk") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22687&entityvalueid=207553&unit=@@wh-Unit-1&entitytype=Float&entityvalue=40&GroupId=53494&ElsterDataType=68&name=@@wh-582-ET-Name-6&OVIndex=9528&DataPointId=" + (this.dataPointId + 2) + "&rwndrnd=0.9772733556889273", state.val)
					}
					if (action === "WWPush") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22688&entityvalueid=207554&unit=&entitytype=Int&entityvalue=0&GroupId=53496&ElsterDataType=64&name=@@wh-582-ET-Name-8&OVIndex=9545&DataPointId=" + (this.dataPointId + 2) + "&rwndrnd=0.5910648822562681", state.val)
					}
					if (action === "Pumpebetriebsart") {
						this.switchState("https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=24723&entityvalueid=210505&unit=&entitytype=VarChar&entityvalue=@@wh-613-EV-Repl-53-650&GroupId=55351&ElsterDataType=64&name=@@wh-613-ET-Name-53&OVIndex=9834&DataPointId=" + (this.dataPointId + 5) + "&rwndrnd=0.3333835266610612", state.val, 210496)
					}
					if (action === "CustomBefehl") {
						try {

							const pArray = state.val.replace(/ /g, '').split(",");
							if (isNaN(pArray[1])) {
								this.log.debug(pArray[1] + " is  not a number");
							}
							this.switchState(pArray[0], parseFloat(pArray[1]))
						} catch (error) {
							this.log.error("No valid custom befehl. Example: ")
							this.log.error('https://www.wemportal.com/Web/UControls/Weishaupt/DataDisplay/ParameterDetails.aspx?Id=22686&entityvalue...., 52');
						}
					}
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