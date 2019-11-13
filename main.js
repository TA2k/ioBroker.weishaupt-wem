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
			// this.getHomesStatus().then(() => {});
			// this.updateInterval = setInterval(() => {
			// 	this.getHomesStatus();
			// }, this.config.interval * 60 * 1000)

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
					'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
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
					form["ctl00_content_tbxUserName"] = this.config.user;
					form["ctl00$content$tbxPassword"] = this.config.password;
					request.post({
						url: "https://www.wemportal.com/Web/Login.aspx",
						headers: {
							'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,lb;q=0.6',
							'Accept-Encoding': 'gzip, deflate, br',
							'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.29 Safari/537.36',
							"Accept": "*/*",
							"Content-Type": "application/x-www-form-urlencoded",
						},
						form: form,
						jar: this.jar,
						followAllRedirects: true,
					}, (err, resp, body) => {
						if (err) {
							this.log.error(err);
							reject();
						} else {
							
							try {
								this.log.debug(body);
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

	refreshToken() {
		return new Promise((resolve, reject) => {
			this.log.debug("refreshToken");

			request.post({
				url: "",
				headers: {
					
				},
				form: {
				},
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}
				try {
				

				} catch (error) {
					this.log.error(error);
					reject();
				}
			});
		});
	}

	getHomesStatus() {
		return new Promise((resolve, reject) => {
			this.log.debug("getHomesStatus");
			request.post({
				url: "",
				headers: {
				
				},
				json: true,
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(err);
					reject();
				}
				try {
					
					resolve();
				} catch (error) {
					this.log.error(error);
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

			clearInterval(this.refreshTokenInterval);
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