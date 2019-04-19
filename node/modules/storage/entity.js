class entity {
    constructor(app, name) {
        this.app = app;
        this.class = null;
        this.db = this.app.storage.getConnection();
        this.coll = null;
        this.name = name;
        this.init();
    }
    init() {
        if (!this.db || !this.coll) {
            this.coll = this.app.storage.getCollection(this.name);
        }
    }
    save(block) {
        this.coll.insert(block);
        this.saveDb();
        return true;

    }
    get(hash) {
        return this.coll.findOne({ 'hash': hash });

    }
    remove(hash) {
        let obj = this.coll.findOne({ hash: hash });
        this.coll.remove(obj);
        this.saveDb();
        return true;
    }
    load(limit, offset, sortby) {
        if (!limit)
            limit = 1000

        if (!offset)
            offset = 0;

        let res = this.coll.chain().find().limit(limit).offset(offset);
        if (sortby)
            res = res.simplesort(sortby[0], !!sortby[1]);

        return res.data();

    }
    count() {
        return this.coll.chain().find().count();
    }
    getCollectio() {
        return this.coll;
    }
    getDB() {
        return this.db
    }
    saveDb() {
        this.db.saveDatabase();
    }
    clear() {
        this.coll.chain().remove();
        return true;
    }
}

module.exports = entity;