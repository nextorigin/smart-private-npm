/*
 * npm-proxy.js: Smart, prototypal proxy for routing traffic between _the_ public npm and _a_ private npm.
 *
 * (C) 2013, Nodejitsu Inc.
 *
 */

var httpProxy = require('http-proxy'),
    EE = require('events').EventEmitter,
    hyperquest = require('hyperquest'),
    util = require('util'),
    url_ = require('url');

//
// ### function NpmProxy (options)
// #### @options {Object} Options for initializing the proxy
// ####   @npm     {Array|string} Public npm CouchDBs we are proxying against.
// ####   @policy  {Object} Default policy
// ####     - npm         {url.parse} Private npm CouchDB we are proxying against.
// ####     - transparent {boolean}   If true: always behaves as a pass-thru to public npm(s).
// ####     - private     {Object}    Set of initial private modules.
// ####     - blacklist   {Object}    Set of initial blacklisted modules.
// ####     - whitelist   {Object}    Set of iniitial whitelisted modules.
// ####   @writePrivateOk {function}  **Optional** Predicate for writing new private packages.
// ####   @log            {function}  **Optional** Log function. Defaults to console.
//
// Constructor function for the NpmProxy object responsible for
// making proxy decisions between multiple npm registries.
//
var NpmProxy = module.exports = function (options) {
  if (!(this instanceof NpmProxy)) { return new NpmProxy(options) }
  EE.call(this);

  var self = this;

  //
  // URL to CouchDB and the proxy instance to use.
  //
  this.npm = options.npm;
  this.log = options.log || console;

  //
  // Remark: if we dont have a specific read/write url,
  // assume we either have an array or an url.parsed object
  //
  this.interval   = options.interval || 60 * 15 * 1000;
  this.currentNpm = this.npm && this.npm.read || this.npm;
  this.isUrlArray(this.npm.read || this.npm);
  //
  // Default these values if there is no read/write
  //
  this.writeNpm = this.npm.write || this.currentNpm;

  this.secure = options.secure || options.strictSSL || options.rejectUnauthorized || false;
  //
  // Setup the http-proxy instance to handle bad respones
  // and allow lax SSL if there is nothing passed in
  //
  this.proxy  = httpProxy.createProxyServer({ secure: this.secure, prependPath: false });
  this.proxy.on('error', this.onProxyError.bind(this));
  //
  // Proxy these events to the main prototype so we don't need to inspect
  // the internal http-proxy instance
  //
  this.proxy.on('start', this.emit.bind(this, 'start'));
  this.proxy.on('end', this.emit.bind(this, 'end'));

  //
  // Handler for decoupling any authorization logic
  // for new private packages from the proxy itself.
  //
  this.writePrivateOk = options.writePrivateOk;

  //
  // Set the policy
  //
  if (options.policy) {
    this.setPolicy(options.policy);
  }
};

util.inherits(NpmProxy, EE);

//
// ### function isUrlArray(urls)
// Handles the case where we have an array of urls so its reusable
//
NpmProxy.prototype.isUrlArray = function (urls) {
  //
  // Begin cycling public npm URLs only if it is an Array
  // we can cycle through.
  //
  if (Array.isArray(urls)) {
    if (urls.length === 1) {
      this.currentNpm = urls[0]
    }
    else {
      this.currentNpm = null;
      this.nextPublicNpm(urls);
      this.intervalId = setInterval(
        this.nextPublicNpm.bind(this, urls),
        this.interval
      );
    }
  }
};

//
// ### function setPolicy (policy)
// Sets the specified `policy` on this instance
//
NpmProxy.prototype.setPolicy = function (policy) {
  //
  // Remark: Pre-transformed the policy Arrays into Objects
  // for fast lookup.
  //
  this.policy           = policy;
  this.policy.blacklist = this.policy.blacklist || {};
  this.policy.cloudant  = this.policy.cloudant || false;
  if (this.policy.transparent) {
    this.private =
    this.decide  =
    this.merge   =
      this.public;
  }
};

//
// ### function nextPublicNpm ()
// Sets the current public npm to a random
// selection (without replacement).
//
NpmProxy.prototype.nextPublicNpm = function (urls) {
  var index   = Math.random() * urls.length | 0,
      lastNpm = this.currentNpm;

  this.currentNpm = urls.splice(index, 1)[0];
  this.log.info('[public npm] %s --> %s', (lastNpm && lastNpm.href) || 'none', this.currentNpm.href);
  if (lastNpm) {
    urls.push(lastNpm);
  }
};

//
// ### function public (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
//
// Make a proxy request to `url` against the public
// npm registry and stream the response back to the `res`.
//
NpmProxy.prototype.public = function (req, res) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      method = req.method.toLowerCase(),
      host,
      npm;

  npm = method !== 'put' && method !== 'delete'
    ? this.currentNpm
    : this.writeNpm;

  host = npm.vhost || npm.host || npm.hostname;

  this.log.info('[public] %s - %s %s %s %j', address, req.method, req.url, host, req.headers);

  this.emit('headers', req, req.headers, npm);

  req.headers.host = host;

  this.proxy.web(req, res, {
    target: npm.href
  });
};

//
// ### function private (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// Make a proxy request to `url` against the private
// npm registry and stream the response back to the `res`.
//
NpmProxy.prototype.private = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;
  if (policy.transparent) {
    return this.public(req, res);
  }

  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      host = policy.npm.vhost || policy.npm.host || policy.npm.hostname;

  this.log.info('[private] %s - %s %s %s %j', address, req.method, req.url, host, req.headers);

  this.emit('headers', req, req.headers, policy.npm);

  req.headers.host = host;

  this.proxy.web(req, res, {
    target: policy.npm.href
  });
};

//
// ### function basicLogin (username, req, res, target)
// #### @username {String} Username of the user logging in
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @target {Object} Target URL for the login/adduser attempt
//
// Instead of the hacky PUT/overwrite login method that npm uses,
// we use the user's username and password to fetch their own user
// object.  If the user does not exist, we attempt to create it.
// (npm does not differentiate the API calls for login and adduser)
//
// If proxy.policy.cloudant is true, user creation will use the
// Cloudant method.  If proxy.policy.cloudant is an object, the
// user properties will be overwritten by that object.  This makes
// it easy to give a user default roles.
//
NpmProxy.prototype.basicLogin = function (username, req, res, target) {
  this.log.info('[basicLogin] intercepting login/adduser for user %s:', username);

  var getRawBody   = require('raw-body'),
      CloudantUser = require('cloudant-user'),
      uri          = url_.parse(target.target),
      auth         = uri.auth && uri.auth.split(':'),
      adminUser    = auth && auth[0] || username,
      self         = this;

  getRawBody(req, function(err, buffer) {
    if (err) return self.onProxyError(err, req, res);

    var user     = JSON.parse(buffer.toString()),
        password = user.password;

    if (password) {
      self.log.info('[basicLogin] found password in body, using couchdb auth for: %s', adminUser);

      var couchdb = {
          host: uri.hostname,
          port: uri.port,
          secure: (uri.protocol === 'https')
        }, couchuser = {
          name: adminUser,
          pass: auth && auth[1] || password
        }, cloudantUser = new CloudantUser(couchdb, couchuser);

      cloudantUser.exists(username, function(err, userObj) {
        var callback = function(err, userObj) {
          if (err) return self.onProxyError(err, req, res);
          var sanitized = util._extend(util._extend({}, userObj), { password_sha: 'XXXXXX', salt: 'XXXXXX' });

          self.log.info('[basicLogin] sending userObj', sanitized);

          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify(userObj));
        }

        if (err) {
          self.log.error('[basicLogin] unable to find user %s: %s', username, err.message);
          err = null;

          if (self.policy.cloudant) {
            self.log.info('[basicLogin] using Cloudant method to create user');

            if (self.policy.cloudant !== true) user = util._extend(user, self.policy.cloudant);
            var args = [username, password, user.email].concat(user.roles, callback);
            cloudantUser.npmCreate.apply(cloudantUser, args);
          } else {
            self.log.info('[basicLogin] using normal method to create user');

            req.body = JSON.stringify(user);
            self.proxy.web(req, res, target);
          }
        } else {
          self.log.info('[basicLogin] successful login for %s', username);

          callback(err, userObj);
        }
      });
    } else {
      self.login.warn('[basicLogin] no password sent in body, proxying anyway');

      self.proxy.web(req, res, target);
    }
  });
};

//
// ### function decide (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// For the `pkg` requested, based on the:
//
// * Whitelist policy
// * Blacklist policy
// * Known private packages
//
// decide whether to proxy to the public or private npm
// registry and then stream the response back to the res
// from whatever registry was selected.
//
NpmProxy.prototype.decide = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;
  if (policy.transparent) {
    return this.public(req, res);
  }
  var packageNamespaceMatch = /^\/-\/package\/(.*?)\//.exec(req.url);

  var address  = req.connection.remoteAddress || req.socket.remoteAddress,
      url      = req.url,
      method   = req.method.toLowerCase(),
      pkg      = packageNamespaceMatch ? packageNamespaceMatch[1] : url.slice(1).split('?').shift().split('/').shift(),
      proxy    = this.proxy,
      self     = this,
      decideFn;

  //
  // Proxy or serve not found based on the decision
  //
  function onDecision(err, target) {
    //
    // If there was no target then this is a 404 by definition
    // even if it exists in the public registry because of a
    // potential whitelist.
    //
    if (err || !target) {
      return self.notFound(req, res, err || { message: 'Unknown pkg: ' + pkg });
    }

    // if X-Forwarded-Host is set, npm returns 404 {"error":"not_found","reason":"no_db_file"}
    if (req.headers["x-forwarded-host"]) delete req.headers["x-forwarded-host"];

    //
    // If we get a valid target then we can proxy to it
    //
    self.log.info('[decide] %s - %s %s %s %j', address, req.method, req.url, target.vhost || target.host || target.hostname, req.headers);

    self.emit('headers', req, req.headers, target);

    req.headers.host = target.vhost || target.host || target.hostname;
    var adduserNew = /\/?-\/user\/org\.couchdb\.user:([^/?]+)$/,
        isNewUser = req.url.match(adduserNew);

    if (isNewUser && req.method === 'PUT' && req.headers.referer === "adduser") {
      var username = isNewUser[1];
      return self.basicLogin(username, req, res, {
        target: target.href
      });
    }
    proxy.web(req, res, {
      target: target.href
    });
  }

  //
  // Calculate the decision function based on the HTTP
  // method. We could potentially optimize this by having two
  // deicison functions since the readUrl method(s) do not
  // have an async-nature.
  //
  // The choice of `standard{Read,Write}Url` vs `whitelist{Read,Write}Url`
  // is an important distinction here because the logic is
  // so drastically different between whitelist and not.
  //
  if (method === 'get' || method === 'head') {
    return policy.whitelist
      ? this.whitelistReadUrl(pkg, policy, onDecision)
      : this.standardReadUrl(pkg, policy, onDecision);
  }

  return policy.whitelist
    ? this.whitelistWriteUrl(pkg, policy, onDecision)
    : this.standardWriteUrl(pkg, policy, onDecision);
};

//
// ### function notFound (req, res)
// Simple 404 handler.
//
NpmProxy.prototype.notFound = function (req, res, err) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      code    = err ? 400 : 404,
      json;

  if (!err) { global.console.trace(); }
  err = err || { message: 'Unknown error' };
  this.log.error('[not found] %s - %s %s %s %j', address, req.method, req.url, err.message, req.headers);

  res.writeHead(code, { 'content-type': 'application/json' });
  json = { error: 'not_found', reason: err.message };
  res.end(JSON.stringify(json));
};

//
// ### function standardReadUrl (pkg, policy, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.
//
NpmProxy.prototype.standardReadUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  //
  // There **IS NO WHITELIST** so if it is already a known private package
  // or part of a blacklist then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise send it to the public npm
  //
  return callback(null, this.currentNpm);
};

//
// ### function standardWriteUrl (pkg, callback)
// #### @pkg {string} npm package to get the write URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target write (i.e. PUT or POST) URL based on the
// `pkg`, `this.policy` and `this.npm` targets..
//
NpmProxy.prototype.standardWriteUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var writeOk = this.writePrivateOk,
      self    = this,
      err;

  //
  // There **IS NO WHITELIST** so if it is already a known private package
  // or part of a blacklist then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise we need to look this package in the public registry
  // - if it does not exist we proxy to the private registry
  // - if it does exist then we proxy to the public registry
  //
  hyperquest({
    uri: url_.resolve(this.writeNpm.href, pkg),
    rejectUnauthorized: this.secure
  })
  .on('error', callback)
  .on('response', function (res) {
    if (res.statusCode == 404) {
      if (writeOk) {
        err = writeOk(policy, self);
        if (err) {
          return callback(err);
        }
      }

      policy.private[pkg] = true;
      return callback(null, policy.npm);
    }

    return callback(null, self.writeNpm);
  });
};

//
// ### function whitelistReadUrl (pkg, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.. Assumes there is
// a whitelist by default.
//
NpmProxy.prototype.whitelistReadUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  //
  // There **IS A WHITELIST** so if it is in the whitelist proxy to the
  // public registry
  //
  if (policy.whitelist[pkg]) {
    return callback(null, this.currentNpm);
  }

  //
  // If it is already a known private package or part of a blacklist
  // then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise it is FORBIDDEN!
  //
  return callback(new Error('Your whitelist policy prevents you from getting ' + pkg));
};

//
// ### function whitelistWriteUrl (pkg, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.. Assumes there is
// a whitelist by default.
//
NpmProxy.prototype.whitelistWriteUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var writePrivateOk = this.writePrivateOk,
      limits         = policy && policy.limits,
      self           = this;

  //
  // There **IS A WHITELIST** so if it is in the whitelist proxy to the
  // public registry
  //
  if (policy.whitelist[pkg]) {
    return callback(null, this.writeNpm);
  }

  //
  // If it is already a known private package or part of a blacklist
  // then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise we need to look this package in the public registry
  // - if it does not exist we proxy to the private registry
  // - if it does exist then we 404
  //
  hyperquest({
    uri: url_.resolve(this.writeNpm.href, pkg),
    rejectUnauthorized: this.secure
  })
  .on('error', callback)
  .on('response', function (res) {
    if (res.statusCode == 404) {
      if (limits && limits.private && Object.keys(policy.private).length >= limits.private) {
        return callback(new Error('Out of private packages. Have you considered upgrading?'));
      }

      policy.private[pkg] = true;
      return callback(null, policy.npm);
    }

    //
    // Otherwise it is FORBIDDEN.
    //
    return callback(new Error('Your whitelist policy prevents you from writing ' + pkg));
  });
};

//
// ### function merge (req, res)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// Concurrently request `/url` against the public
// and private npm registry and stream the JSON
// merged responses back to `res` as a single
// JSON object.
//
NpmProxy.prototype.merge = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      method  = req.method,
      url     = req.url,
      self    = this,
      contentTypes = {},
      responses    = {};

  //
  // ### function makeRequest (target)
  // Makes a request to `req.url` to the
  // specified target.
  //
  function makeRequest(target) {
    var headers = Object.keys(req.headers)
      .reduce(function (all, key) {
        all[key] = req.headers[key];
        return all;
      }, {});

    //
    // Set the correct host header.
    //
    headers.host = target.host;

    self.log.info('[merge] %s - %s %s %s %j', address, req.method, req.url, target.host, req.headers);
    return hyperquest({
      url:     url_.resolve(target.href, url),
      method:  method,
      headers: headers
    });
  }

  //
  // ### function onResponse (type, pRes)
  // Sets the content type from the proxy
  // response.
  //
  function onResponse(type, pRes) {
    contentTypes[type] = pRes.headers['content-type'].split(';')[0];
    responses[type]    = pRes;

    //
    // If we have both a public and a private
    // response.
    //
    if (responses.public && responses.private) {
      if (contentTypes.public === contentTypes.private) {
        return self.merge.handlers[contentTypes.public](req, res, responses);
      }

      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Content-Type mismatch: ' + JSON.stringify(contentTypes));
    }
  }

  makeRequest(policy.npm)
    .on('response', onResponse.bind(null, 'private'));

  makeRequest(this.currentNpm)
    .on('response', onResponse.bind(null, 'public'));
};

//
// ### @merge.handlers {Object}
// Merge handlers for multiple proxy responses.
//
NpmProxy.prototype.merge.handlers = {
  'text/plain': function textPlain(req, res, responses) {
    //
    // TODO: Properly merge these together.
    //
    responses.public.pipe(res);
  },
  'text/xml': function textXml(req, res, responses) {
    //
    // TODO: Properly merge these together.
    //
    responses.public.pipe(res);
  },
  'application/json': function appJson(req, res, responses) {
    //
    // TODO: Properly merge these together.
    //
    responses.public.pipe(res);
  }
};

//
// ### function onProxyError (err, req, res)
// `http-proxy` "error" event handler
//
NpmProxy.prototype.onProxyError = function (err, req, res) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      code    = res.statusCode || 500,
      json;

  this.log.error('[proxy error] %s - %s %s %s %j', address, req.method, req.url, err.message, req.headers);

  if (!res.headersSent) {
    res.writeHead(code, { 'content-type': 'application/json' });
  }

  json = { error: 'proxy_error', reason: err.message };
  res.end(JSON.stringify(json));
};
