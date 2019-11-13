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
							const label = dataCell.nextElementSibling.textContent.trim().replace(/\./g, "_");
							const value = dataCell.nextElementSibling.nextElementSibling.textContent.trim()
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
							this.setState(deviceInfo + "." + label, value, true);

						}
					}
					resolve();
				} catch (error) {
					this.log.error(error);
					this.log.error(error.stack);
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
			// The state was changed
			//	this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
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