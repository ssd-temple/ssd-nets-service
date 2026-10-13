const response = {
  json: jest.fn(),
  send: jest.fn(),
  status: jest.fn(),
};

response.json.mockReturnValue(response);
response.send.mockReturnValue(response);
response.status.mockReturnValue(response);

module.exports = {
  next: jest.fn(),
  response,
};
