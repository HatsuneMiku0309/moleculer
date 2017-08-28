/*
 * moleculer
 * Copyright (c) 2017 Ice Services (https://github.com/ice-services/moleculer)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");

const NodeCatalog = require("./node-catalog");
const ServiceCatalog = require("./service-catalog");
const EventCatalog = require("./event-catalog");
const ActionCatalog = require("./action-catalog");

const RoundRobinStrategy = require("../strategies").RoundRobin;

class Registry {

	constructor(broker) {
		this.broker = broker;
		this.logger = broker.getLogger("registry");

		this.opts = broker.options.registry || {};
		this.opts.circuitBreaker = broker.options.circuitBreaker || {};

		this.strategy = this.opts.strategy || new RoundRobinStrategy();

		this.nodes = new NodeCatalog(this, broker, this.logger);
		this.services = new ServiceCatalog(this, broker, this.logger);
		this.events = new EventCatalog(this, broker, this.logger);
		this.actions = new ActionCatalog(this, broker, this.logger);

	}

	processNodeInfo(payload) {
		this.nodes.processNodeInfo(payload);
	}

	nodeDisconnected(nodeID, isUnexpected) {
		let node = this.nodes.get(nodeID);
		if (node && node.available) {
			node.disconnected(isUnexpected);

			this.unregisterServicesByNode(node.id);

			this.broker.emitLocal("$node.disconnected", { node, unexpected: !!isUnexpected });

			this.logger.warn(`Node '${node.id}' disconnected!`);

			this.broker.servicesChanged(false);
		}
	}

	nodeHeartbeat(payload) {
		this.nodes.heartbeat(payload);
	}

	registerLocalService(svc) {
		const service = this.services.add(this.nodes.localNode, svc.name, svc.version, svc.settings);

		this.registerActions(this.nodes.localNode, service, svc.actions);

		this.logger.info(`'${service.name}' service is registered!`);
	}

	registerServices(node, serviceList) {
		//this.logger.info("< ---- INFO:", node, node.services); // TODO

		serviceList.forEach(svc => {
			let prevActions;
			let service = this.services.get(svc.name, svc.version, node.id);
			if (!service) {
				service = this.services.add(node, svc.name, svc.version, svc.settings);
			} else {
				prevActions = Object.assign({}, service.actions);
				service.update(svc);
			}

			this.registerActions(node, service, svc.actions);

			// remove old actions which is not exist
			if (prevActions) {
				_.forIn(prevActions, (action, name) => {
					if (!svc.actions[name])
						this.unregisterAction(node, name);
				});
			}
		});

		// remove old services which is not exist in new serviceList
		this.services.services.forEach(service => {
			if (service.node != node) return;

			let exist = false;
			serviceList.forEach(svc => {
				if (service.equals(svc.name, svc.version))
					exist = true;
			});

			if (!exist) {
				// This service is removed on remote node!
				this.unregisterService(service.name, service.version, node.id);
			}
		});
	}

	registerActions(node, service, actions) {
		_.forIn(actions, action => {
			this.actions.add(node, service, action);
			service.addAction(action);
		});
	}

	getActionEndpoints(actionName) {
		return this.actions.get(actionName);
	}

	getActionEndpointByNodeId(actionName, nodeID) {
		const list = this.actions.get(actionName);
		if (list)
			return list.getEndpointByNodeID(nodeID);
	}

	unregisterService(name, version, nodeID) {
		this.services.remove(name, version, nodeID || this.broker.nodeID);
	}

	unregisterServicesByNode(nodeID) {
		this.services.removeAllByNodeID(nodeID);
	}

	unregisterAction(node, name) {
		this.actions.remove(name, node.id);
	}

	getLocalNodeInfo() {
		const res = _.pick(this.nodes.localNode, ["uptime", "ipList", "versions"]);
		res.services = this.services.list({ onlyLocal: true, withActions: true });
		res.events = {}; // TODO

		return res;
	}

	/**
	 * Get a filtered list of actions
	 *
	 * @param {Object} {onlyLocal = false, skipInternal = false, withEndpoints = false}
	 * @returns {Array}
	 *
	 * @memberof Registry
	 */
	getActionList({onlyLocal = false, skipInternal = false, withEndpoints = false}) {
		let res = [];
		// TODO
		this.actions.actions.forEach((entry, key) => {
			if (skipInternal && /^\$node/.test(key))
				return;

			if (onlyLocal && !entry.hasLocal())
				return;

			let item = {
				name: key,
				count: entry.count(),
				hasLocal: entry.hasLocal(),
				available: entry.hasAvailable()
			};

			if (item.count > 0) {
				const ep = entry.endpoints[0];
				if (ep)
					item.action = _.omit(ep.action, ["handler", "service"]);
			}
			if (item.action == null || item.action.protected === true) return;

			if (withEndpoints) {
				if (item.count > 0) {
					item.endpoints = entry.endpoints.map(ep => {
						return {
							nodeID: ep.node.id,
							state: ep.state
						};
					});
				}
			}

			res.push(item);
		});

		return res;
	}
}

module.exports = Registry;