/*
* Orwell http://github.com/gettocat/orwell
* Platform for building decentralized applications
* MIT License
* Copyright (c) 2017 Nanocat <@orwellcat at twitter>
*/

let bitPony = require('bitpony');
let protocol = function (app, nodes) {
    this.app = app;
    this.nodes = nodes;
    //now we can change network onfly.
    this.separator = () => { return this.app.cnf(this.app.cnf('network')).magic };
    this.port = () => { return this.app.cnf(this.app.cnf('network')).port };
}

protocol.prototype = {
    chunks: [],
    nodename: '',
    createMessage: function (type, data) {

        var msg = JSON.stringify(data);
        //magic
        var buff = new Buffer(this.separator(), 'hex');
        var writer = new bitPony.writer(buff);
        writer.uint32(rand(0, 0xffffffff), true)//message round number
        writer.uint32(0, true);//message order in list (used if messages count > 1). Can split big message to some small
        writer.uint32(1, true);//messages count
        //command,
        writer.string(type, true);
        //checksum,
        writer.hash(this.app.crypto.sha256(this.app.crypto.sha256(type + msg)).toString('hex'), true);
        //payload_raw,
        writer.string(msg, true);
        return writer.getBuffer()
    },
    readMessage: function (buff) {

        if (!(buff instanceof Buffer))
            buff = new Buffer(buff, 'hex');

        if (buff.toString('hex').indexOf(this.separator()) != 0) {
            this.chunks.push(buff);
            buff = Buffer.concat(this.chunks);
            //return false;
        }

        var package = {}, data = null
        var reader = new bitPony.reader(buff);
        var res = reader.uint32(0);

        package.magic = res.result;
        res = reader.uint32(res.offset);
        package.rand = res.result;
        res = reader.uint32(res.offset);
        package.order = res.result;
        res = reader.uint32(res.offset);
        package.messages = res.result;
        res = reader.string(res.offset);
        package.command = res.result.toString('utf8');
        res = reader.hash(res.offset);
        package.checksum = res.result;
        res = reader.string(res.offset);
        package.payload = res.result;

        if (package.messages > 1) {
            if (!this.chunks[package.rand])
                this.chunks[package.rand] = {};
            this.chunks[package.rand][package.order] = package.payload;
            data = null;
            if (Object.keys(this.chunks[package.rand]).length >= package.messages) {
                var buffer = Buffer.concat(this.chunks[package.rand]);
                data = buffer.toString('utf8');
                this.chunks[package.rand] = null;
                delete this.chunks[package.rand];
            }
        }

        if (package.messages == 1)
            data = package.payload.toString('utf8');

        if (!data)//multiple message
            return false;

        var myhash = this.app.crypto.sha256(this.app.crypto.sha256(package.command + data)).toString('hex');
        if (myhash != package.checksum) {
            //not full message, wait another chunks
            this.chunks = [];
            this.chunks[0] = buff;
            if (this.app.cnf('debug').protocol)
                this.app.debug('error', 'network', "!! cant read message, hash is not valid or size of message is not equals, size (" + package.checksum + "," + myhash + ")")

            return false;
        }

        return [
            package.command,
            data ? JSON.parse(data) : {}
        ]
    },
    init: function () {
        this.app.emit("network.init.start");

        let nodes = this.getNodeList();
        for (let i in nodes) {
            if (this.app.cnf('debug').network)
                this.app.debug("info", 'network', 'init node ' + nodes[i])
            this.initNode(nodes[i])
        }
    },
    initNode: function (addr, afterInit) {
        this.app.emit("net.node.add", addr, (rinfo) => {

            this.app.on("net.node.init" + this.getAddressUniq(rinfo), () => {
                this.app.removeAllListeners("net.node.init" + this.getAddressUniq(rinfo));
                if (afterInit instanceof Function)
                    afterInit(rinfo);
            });

            let d = this.nodes.get("data/" + this.getAddressUniq(rinfo));
            d.initiator = 1;
            this.nodes.set("data/" + this.getAddressUniq(rinfo), d);
            this.sendOne(rinfo, 'version', {
                version: this.app.cnf('consensus').version || 0,
                lastblock: this.app.db.get('latest'),
                agent: this.getUserAgent(),
                nodekey: this.getNodeKey(),
                timezone: 0//offset UTC
            })
        });

    },
    getNodeList: function () {
        let list = this.nodes.get("connections");
        if (!list || !(list instanceof Array))
            list = [];

        if (!list.length) {
            let node_list = this.getNodesFromList();
            if (!node_list || !node_list.length)
                list = this.app.cnf(this.app.cnf('network')).nodes;
            else
                list = node_list;
        }

        return list;
    },
    checkNodes: function () {

        let list = this.getNodeList();
        for (let i in list) {

            let socket = this.nodes.get("connection/" + list[i]);
            if (this.app.cnf('debug').network)
                this.app.debug('info', 'network', "check peer " + list[i] + " OK: ", !(!socket || socket.destroyed === true));

            if (!socket || socket.destroyed === true) {
                if (this.app.cnf('debug').network)
                    this.app.debug('notice', 'network', "remove peer " + list[i])
                this.app.emit("net.connection.remove", list[i]);
            }


        }

    },
    getNodeKey: function () {
        if (!this.app.cnf('node').publicKey) {
            if (this.app.cnf('debug').network)
                this.app.debug('error', 'network', "to start node need generate KeyPair")
            throw new Error('error, to start node need generate KeyPair');
        }
        return this.nodeKey = this.app.crypto.generateAddress(this.app.cnf('node').publicKey)
    },
    handleMessage: function (data, rinfo, self) {

        var a = this.readMessage(data);
        if (a) {
            if (this.app.cnf('debug').network)
                this.app.debug("info", 'network', "< recv " + a[0] + " < " + JSON.stringify(a[1]))
            //todo get node-info by addr and get nodeKey
            let nodeKey = a[1].nodekey;
            if (!nodeKey) 
                nodeKey = this.app.network.nodes.get('address/' + this.app.network.protocol.getAddressUniq(rinfo));
            

            this.app.emit("network.newmessage", { type: a[0], data: a[1], self: self || a[1].nodekey == this.nodeKey });

            if (!(self || a[1].nodekey == this.nodeKey))
                this.nodes.updateRecvTime(rinfo);

            this.app.emit("handler.message", {
                type: a[0],
                data: a[1],
                rinfo: rinfo,
                self: self || a[1].nodekey == this.nodeKey
            });
            return a[1].nodekey;
        }

        return false;
    },
    sendAll: function (type, data) {
        this.app.debug('info', 'network', "> send [ all ] " + type + " > " + JSON.stringify(data))
        this.app.emit("network.emit", { type: type, data: data });
        this.app.emit("net.send", this.createMessage(type, data))
    },
    sendOne: function (rinfo, type, data) {
        this.app.debug('info', 'network', "> send [ one ] " + type + " > " + JSON.stringify(data))
        this.app.emit("network.send", { type: type, data: data, rinfo: rinfo });
        this.app.emit("net.send", this.createMessage(type, data), rinfo)
    },
    addNode: function (nodeAddr, cb) {

        let a = this.getUniqAddress(nodeAddr);
        nodeAddr = nodeAddr.replace("::ffff:", "")

        let adding = true;
        let list = this.nodes.get("connections");
        if (!list || !(list instanceof Array))
            list = [];


        let finded = false;
        for (let i in list) {
            if (list[i] && (list[i].indexOf(a.remoteAddress.replace("::ffff:", "")) >= 0 || list[i] == nodeAddr)) {
                finded = true;
                adding = false;
                break;
            }
        }

        if (!finded) {
            this.initNode(nodeAddr.replace("::ffff:", ""), cb);
        }

        return adding;
    },
    checkNodes: function () {

        let list = this.getNodeList();
        for (let i in list) {

            let socket = this.nodes.get("connection/" + list[i]);

            if (this.app.cnf('debug').peers)
                this.app.debug('info', 'network', "check peer " + list[i] + " OK: ", !(!socket || socket.destroyed === true));

            if (!socket || socket.destroyed === true) {
                if (this.app.cnf('debug').peers)
                    this.app.debug('info', 'network', "remove peer " + list[i])
                this.app.emit("net.connection.remove", list[i]);

                if (!list[i])
                    return;

                if (this.app.cnf('debug').peers)
                    this.app.debug('info', 'network', "try reconnect peer " + list[i])
                this.addNode(list[i], () => {
                    if (this.app.cnf('debug').peers)
                        this.app.debug('info', 'network', "reconnected to peer " + list[i])
                })
            }


        }

    },
    getAddressUniq: function (rinfo) {
        return rinfo.remoteAddress.replace("::ffff:", "") + "/" + rinfo.remotePort + "/" + rinfo.port
    },
    getUniqAddress: function (key) {
        if (!key)
            throw new Error('undefined key');
        var a = key.split("/");
        return {
            remoteAddress: a[0],
            remotePort: a[1],
            port: a[2]
        }
    },
    exceptNode: function (addr) {
        var arr = [];

        var list = this.nodes.get("connections");
        if (!list || !(list instanceof Array))
            list = [];

        if (!list.length)
            list = config.nodes;

        for (var i in list)
            if (list[i] != addr) {
                var a = this.getUniqAddress(list[i]);

                if (a.remoteAddress.indexOf("127.0.0.1") >= 0 || (addr && a.remoteAddress.indexOf(addr) >= 0))
                    continue;

                var key = a.remoteAddress.replace("::ffff:", "") + "//" + a.port;
                if (arr.indexOf(key) < 0)
                    arr.push(key);
            }

        return arr;
    },
    getNodesFromList: function () {
        const fs = require('fs')
        let path = '';//app.getPath('userData') + "/nodes.conf";
        let content = ""
        try {
            content = fs.readFileSync(path).toString();
        } catch (e) {
            //debug(e);
            //fs.closeSync(fs.openSync(path, 'w'));
        }

        let nodes_conf = content.split("\n");
        let node_list = [];
        for (let i in nodes_conf) {
            if (nodes_conf[i].trim())
                node_list.push(nodes_conf[i].trim());
        }

        return node_list
    },
    saveNodesToList: function (nodes) {
        const fs = require('fs')
        let path = '';
        fs.writeFileSync(path, nodes.join("\n"));
    },
    saveNodes: function () {
        const fs = require('fs')
        let path = '';//app.getPath('userData') + "/nodes.conf";
        let nodes = this.exceptNode();

        let node_list = this.getNodesFromList();
        for (let i in nodes) {
            let finded = 0;

            for (let k in node_list) {
                if (nodes[i] == node_list[k]) {
                    finded = 1;
                    break;
                }
            }

            if (finded)
                continue;

            if (nodes[i])
                node_list.push(nodes[i].trim());
        }

        this.saveNodesToList(node_list)
    },
    getRandomNode: function () {
        var list = this.exceptNode(""), n = list[rand(0, list.length - 1)];
        return n;
    },
    getUserAgent: function () {
        var os = require('os'), process = require('process')
        var ua = "%agent%:%agent_ver%/%net%:%blockchain_ver%/%platform%:%platform_ver%/%os%:%os_ver%/%uptime%";
        return ua
            .replace("%agent%", this.app.cnf('agent').name)
            .replace("%agent_ver%", this.app.cnf('agent').version)
            .replace("%net%", this.app.cnf('network'))
            .replace("%blockchain_ver%", this.app.cnf('consensus').version)
            .replace("%platform%", 'nodejs')
            .replace("%platform_ver%", process.version)
            .replace("%os%", os.platform())
            .replace("%os_ver%", os.release())
            .replace("%uptime%", process.uptime());
    },
    createCheckNodeTask: function (seconds) {
        setTimeout(function () {

            this.app.debug('debug', 'network', "check nodes");
            this.checkNodes();
            this.saveNodes();
            this.createCheckNodeTask(seconds)

        }, seconds);
    }
}

var rand = function (min, max) {
    return parseInt(Math.random() * (max - min) + min);
}

module.exports = protocol;