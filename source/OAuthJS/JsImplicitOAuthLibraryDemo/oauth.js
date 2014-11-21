﻿(function () {
    function copy(obj, target) {
        var val = target || {};
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                val[key] = obj[key];
            }
        }
        return val;
    }

    function OAuthClient(settings) {
        this.settings = copy(settings);
        this.store = settings.store || window.localStorage;
    }

    OAuthClient.stateKey = "OAuthClient.state";

    OAuthClient.prototype.makeImplicitRequest = function () {
        var request = this.createImplicitRequest();
        window.location = request.url;
    }

    OAuthClient.prototype.createImplicitRequest = function (settings) {
        settings = settings || {};
        settings = copy(settings, copy(this.settings));

        var state = (Date.now() + Math.random()) * Math.random();
        state = state.toString().replace(".", "");

        var url =
            settings.authorizationUrl + "?" +
            "client_id=" + encodeURIComponent(settings.clientId) + "&" +
            "response_type=token&" +
            "redirect_uri=" + encodeURIComponent(settings.callbackUrl) + "&" +
            "state=" + encodeURIComponent(state);

        if (settings.scope) {
            url += "&scope=" + encodeURIComponent(settings.scope);
        }

        if (settings.prompt) {
            url += "&prompt=" + encodeURIComponent(settings.prompt);
        }

        this.store.setItem(OAuthClient.stateKey, state);

        return {
            state: state,
            url: url
        };
    }

    OAuthClient.prototype.parseResult = function (queryString) {
        queryString = queryString || location.hash;

        var idx = queryString.lastIndexOf("#");
        if (idx >= 0) {
            queryString = queryString.substr(idx + 1);
        }

        var params = {},
            regex = /([^&=]+)=([^&]*)/g,
            m;

        var counter = 0;
        while (m = regex.exec(queryString)) {
            params[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
            if (counter++ > 20) {
                return {
                    error: "Response exceeded expected number of parameters"
                };
            }
        }

        for (var prop in params) {
            return params;
        }
    }

    OAuthClient.prototype.readImplicitResult = function (queryString) {
        var state = this.store.getItem(OAuthClient.stateKey);
        this.store.removeItem(OAuthClient.stateKey);

        var result = OAuthClient.prototype.parseResult(queryString);
        if (!result) {
            return {
                error: "No OAuth Response"
            }
        }

        if (result.error) {
            return {
                error: result.error
            }
        }

        if (!state || result.state !== state) {
            return {
                error: "Invalid State"
            }
        }

        var token = result.access_token;
        if (!token) {
            return {
                error: "No Access Token"
            }
        }

        var expires_in = result.expires_in;
        if (!expires_in) {
            return {
                error: "No Token Expiration"
            }
        }

        return {
            access_token: token,
            expires_in: expires_in
        };
    }

    function Token(access_token, expires_at) {
        this.access_token = access_token;
        this.expires_at = parseInt(expires_at);

        Object.defineProperty(this, "expired", {
            get: function () {
                var now = parseInt(Date.now() / 1000);
                return this.expires_at < now;
            }
        });

        Object.defineProperty(this, "expires_in", {
            get: function () {
                var now = parseInt(Date.now() / 1000);
                return this.expires_at - now;
            }
        });
    }

    Token.fromOAuthResponse = function (response) {
        if (response.error) {
            return new Token(null, 0);
        }

        var now = parseInt(Date.now() / 1000);
        var expires_at = now + parseInt(response.expires_in);
        return new Token(response.access_token, expires_at);
    }

    Token.fromJSON = function (json) {
        if (json) {
            try {
                var obj = JSON.parse(json);
                return new Token(obj.access_token, obj.expires_at);
            }
            catch (e) {
            }
        }
        return new Token(null, 0);
    }

    Token.prototype.toJSON = function () {
        return JSON.stringify({
            access_token: this.access_token,
            expires_at: this.expires_at
        });
    }

    function FrameLoader(url) {
        this.url = url;
    }

    FrameLoader.prototype.load = function (success, error) {
        var frameHtml = '<iframe style="display:none"></iframe>';
        var frame = $(frameHtml).appendTo("body");

        function cleanup() {
            window.removeEventListener("message", message, false);
            if (handle) {
                window.clearTimeout(handle);
            }
            handle = null;
            frame.remove();
        }

        function cancel(e) {
            cleanup();
            if (error) {
                error();
            }
        }

        function message(e) {
            if (handle && e.origin === location.protocol + "//" + location.host) {
                cleanup();
                if (success) {
                    success(e.data);
                }
            }
        }

        var handle = window.setTimeout(cancel, 5000);
        window.addEventListener("message", message, false);
        frame.attr("src", this.url);
    }

    function TokenManager(settings) {
        settings = settings || {};

        this._settings = settings;
        this._store = settings.store || window.localStorage;

        this._callbacks = {
            tokenRemovedCallbacks : [],
            tokenExpiringCallbacks: [],
            tokenExpiredCallbacks: [],
            tokenObtainedCallbacks: []
        };

        loadToken(this);
        configureTokenExpiring(this);
        configureTokenExpired(this);
        configureAutoRenewToken(this);
    }

    TokenManager.storageKey = "TokenManager.token";

    TokenManager.prototype.saveToken = function (token) {
        this.token = token;

        if (this._settings.persistToken && token && !token.expired) {
            this._store.setItem(TokenManager.storageKey, token.toJSON());
        }
        else {
            this._store.removeItem(TokenManager.storageKey);
        }

        if (token) {
            callTokenObtained(this);
        }
        else {
            callTokenRemoved(this);
        }
    }

    function loadToken(mgr) {
        if (mgr._settings.persistToken) {
            var tokenJson = mgr._store.getItem(TokenManager.storageKey);
            if (tokenJson) {
                var token = Token.fromJSON(tokenJson);
                if (!token.expired) {
                    mgr.token = token;
                }
            }
        }
    }

    function callTokenRemoved(mgr) {
        mgr._callbacks.tokenRemovedCallbacks.forEach(function (cb) {
            cb();
        });
    }

    function callTokenExpiring(mgr) {
        mgr._callbacks.tokenExpiringCallbacks.forEach(function (cb) {
            cb();
        });
    }

    function callTokenExpired(mgr) {
        mgr._callbacks.tokenExpiredCallbacks.forEach(function (cb) {
            cb();
        });
    }

    function callTokenObtained(mgr) {
        mgr._callbacks.tokenObtainedCallbacks.forEach(function (cb) {
            cb();
        });
    }

    TokenManager.prototype.addOnTokenRemoved = function (cb) {
        this._callbacks.tokenRemovedCallbacks.push(cb);
    }

    TokenManager.prototype.addOnTokenObtained = function (cb) {
        this._callbacks.tokenObtainedCallbacks.push(cb);
    }

    TokenManager.prototype.addOnTokenExpiring = function (cb) {
        this._callbacks.tokenExpiringCallbacks.push(cb);
    }

    TokenManager.prototype.addOnTokenExpired = function (cb) {
        this._callbacks.tokenExpiredCallbacks.push(cb);
    }

    TokenManager.prototype.removeToken = function () {
        this.saveToken(null);
    }

    TokenManager.prototype.redirectForToken = function () {
        var oauth = new OAuthClient(this._settings);
        var request = oauth.createImplicitRequest();
        window.location = request.url;
    }

    TokenManager.prototype.processTokenCallback = function (success, error) {
        var oauth = new OAuthClient(this._settings);
        var result = oauth.readImplicitResult(location.hash);
        if (result.error) {
            if (error) {
                error(result.error);
            }
        }
        else {
            var token = Token.fromOAuthResponse(result);
            this.saveToken(token);
            if (success) {
                success();
            }
        }
    }

    TokenManager.prototype.renewTokenSilent = function (success, error) {
        var settings = copy(this._settings);
        settings.callbackUrl = settings.frameCallbackUrl;
        settings.prompt = "none";

        var oauth = new OAuthClient(settings);
        var request = oauth.createImplicitRequest();

        var frame = new FrameLoader(request.url);
        frame.load(function (hash) {
            var result = oauth.readImplicitResult(hash);
            if (!result.error) {
                var token = Token.fromOAuthResponse(result);
                this.saveToken(token);
                if (success) {
                    success();
                }
            }
        }.bind(this), function () {
            if (error) {
                error();
            }
        });
    }

    TokenManager.prototype.processTokenCallbackSilent = function () {
        if (window.top && window !== window.top) {
            var hash = window.location.hash;
            if (hash) {
                window.top.postMessage(hash, location.protocol + "//" + location.host);
            }
        };
    }

    function configureTokenExpiring(mgr) {

        function callback() {
            handle = null;
            callTokenExpiring(mgr);
        }

        var handle = null;
        function cancel() {
            if (handle) {
                window.clearTimeout(handle);
                handle = null;
            }
        }

        function setup(duration) {
            handle = window.setTimeout(callback, duration * 1000);
        }

        function configure() {
            cancel();

            var token = mgr.token;
            if (token && !token.expired) {
                var duration = token.expires_in;
                if (duration > 60) {
                    setup(duration - 60);
                }
                else {
                    callback();
                }
            }
        }
        configure();

        mgr.addOnTokenObtained(configure);
        mgr.addOnTokenRemoved(cancel);
    }

    function configureAutoRenewToken(mgr) {

        if (mgr._settings.autoRenewToken) {

            mgr.addOnTokenExpiring(function () {
                mgr.renewTokenSilent();
            });

        }
    }

    function configureTokenExpired(mgr) {

        function callback() {
            handle = null;

            var token = mgr.token;
            if (token && token.expired) {
                mgr.saveToken(null);
            }

            callTokenExpired(mgr);
        }

        var handle = null;
        function cancel() {
            if (handle) {
                window.clearTimeout(handle);
                handle = null;
            }
        }

        function setup(duration) {
            handle = window.setTimeout(callback, duration * 1000);
        }

        function configure() {
            cancel();
            var token = mgr.token;
            if (token && token.expires_in > 0) {
                // register 1 second beyond expiration so we don't get into edge conditions for expiration
                setup(token.expires_in + 1);
            }
        }
        configure();

        mgr.addOnTokenObtained(configure);
        mgr.addOnTokenRemoved(cancel);
    }

    // exports
    window.TokenManager = TokenManager;
})();