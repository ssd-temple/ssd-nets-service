const {
  initialize,
  sentToTerminal,
  reset,
  reqPayload,
  checkACKorNACK,
} = require("nets-service-sdk").communication;
const logger = require("nets-service-sdk").logger(module);
const services = require("nets-service-sdk");
const mockServices = require('./utils/utils.helper.mock');
const { generatePaymentRequest } = require("nets-service-sdk").hexRequest;

const express = require("express");
const ioClient = require("socket.io-client");
const http = require("http");
const ioBack = require("socket.io");
let socket;
let httpServer;

const testCase = 10;
describe("Payment test cases", () => {
  beforeAll((done) => {
    const app = express();
    const httpServer = app.listen(8080, () => { });
    global.io = ioBack(httpServer);
    initialize();
    done();
  });
  afterAll((done) => {
    global.io.close();

    done();
  });

  beforeEach((done) => {
    // Setup
    // Do not hardcode server port and address, square brackets are used for IPv6
    const url = `http://localhost:8080`;
    socket = ioClient.connect(url);
    socket.on("connect", () => {
      done();
    });

    socket.emit("ADD_CLIENT_SERVICE", {}, (val) => { });

    // global.io.on("connection", (socket) => {
    //   socket.on("ADD_CLIENT_SERVICE", (data) => {
    //     socket.join("clientRoom");
    //     const clients = socket.adapter.rooms.get("clientRoom");
    //     for (const clientId of clients) {
    //     }
    //   });
    //   socket.on("disconnect", () => {});
    // });
  });

  afterEach((done) => {
    // Cleanup
    if (socket.connected) {
      socket.disconnect();
    }
    done();
  });

  describe("basic socket.io example", () => {
    test("should communicate", (done) => {
      // once connected, emit Hello World
      global.io.emit("echo", "Hello World");
      socket.once("echo", (message) => {
        // Check that the message matches
        expect(message).toBe("Hello World");
        done();
      });
      global.io.on("connection", (mySocket) => {
        expect(mySocket).toBeDefined();
      });
    });
    test("should communicate with waiting for socket.io handshakes", (done) => {
      // Emit sth from Client do Server
      socket.emit("examlpe", "some messages");
      // Use timeout to wait for socket.io server handshakes
      setTimeout(() => {
        // Put your server side expect() here
        done();
      }, 50);
    });
  });

  switch (testCase) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
      test("Test case " + testCase, () => {
        const body = {
          ecn: 140923022301,
          amount: "0.7",
          reference: "bTLnXuig073",
          isCreditTxn: false,
        };
        logger.log({
          level: "info",
          message: "payload",
        });
        reset();
        calculated = generatePaymentRequest(body);

        global.port.write(calculated.buffer);
        checkACKorNACK();
      });
      break;
    case 10:
      test("Test case 10", () => {
        const body = {
          ecn: 140923022301,
          amount: "0.7",
          reference: "bTLnXuig073",
          isCreditTxn: false,
        };
        reset(body, "PAYMENT");
        const newXor = services.xorCalculation("456576")
        const calculated = generatePaymentRequest(body);
        const temp = calculated.hexString.substring(0, calculated.hexString.length - 2) + newXor
        const buffer = Buffer.from(temp, "hex");
        global.port.write(buffer);
        checkACKorNACK();
      });
      break;
  }
});
