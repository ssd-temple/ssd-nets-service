/**
 * AMQ Module - Main entry point
 * Exports connection, subscriber, and publisher instances
 */

const connection = require("./connection");
const subscriber = require("./subscriber");
const publisher = require("./publisher");

module.exports = {
    connection,
    subscriber,
    publisher,
};
