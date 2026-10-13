const services = require("nets-service-sdk/src/utils.helper");

module.exports = {
  xorCalculation: jest.spyOn(services, "xorCalculation"),
};
