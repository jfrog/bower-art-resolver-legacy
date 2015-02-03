var Q = require('q');
var util = require('util');
var url = require('url');
var mout = require('mout');
var path = require('path');
var request = require('request');
var Config = require('bower-config');
var download = require('bower-poc').util.download;
var createError = require('bower-poc').util.createError;
var extract = require('bower-poc').util.extract;
var Resolver = require('bower-poc').resolverBase;

//TODO: implicit url - bower install arti://...

function ArtifactoryResolver(decEndpoint, config, logger) {
    var pair;
    Resolver.call(this, decEndpoint, config, logger);

    this._artifactoryRegistryAddress = ArtifactoryResolver.extractArtifactoryRegistry(this._config);

    pair = ArtifactoryResolver.getOrgRepoPair(this._source);
    if(!pair){
        throw createError('Invalid Artifactory Registry', 'EINVEND', {
            details: this._source + ' does not seem to be a valid Artifactory registry response!'
        });
    }
    this._org = pair.org;
    this._repo = pair.repo;
}

util.inherits(ArtifactoryResolver, Resolver);
mout.object.mixIn(ArtifactoryResolver, Resolver);

/*ArtifactoryResolver.resolverMatch = function (source){
    if(/^art?:\/\//i.exec(source))
        return true;

    return false;
}*/

// Abstract functions that must be implemented by concrete resolvers
ArtifactoryResolver.prototype._resolve = function () {
    var msg;
    var that = this;
    var requestUrl = this._artifactoryRegistryAddress + '/binaries/' + this._org + '/' + this._repo +
        '.git/' + this._target;

    requestUrl = url.format(requestUrl);
    var artifactoryRemote = url.parse(requestUrl);
    var tempDir = this._tempDir;
    var reqHeaders = {};
    var bowerConfig = this._config;
    var target = this._target;

    var resolve = ArtifactoryResolver.doArtifactoryHeadRequest(requestUrl, bowerConfig)
        .then(function (headResponse){
            that._response = headResponse;
            var contentDisposition = collectHeaderFileName(headResponse);
            var file = path.join(tempDir, contentDisposition);
            return download(requestUrl, file, {
                proxy: artifactoryRemote.protocol === 'https:' ? that._config.httpsProxy : that._config.proxy,
                strictSSL: that._config.strictSsl,
                timeout: that._config.timeout,
                headers: reqHeaders
            })
                .progress(function (state) {
                    // Retry?
                    if (state.retry) {
                        msg = 'Download of ' + requestUrl + ' failed with ' + state.error.code + ', ';
                        msg += 'retrying in ' + (state.delay / 1000).toFixed(1) + 's';
                        that._logger.debug('error', state.error.message, { error: state.error });
                        return that._logger.warn('retry', msg);
                    }

                    // Progress
                    msg = 'received ' + (state.received / 1024 / 1024).toFixed(1) + 'MB';
                    if (state.total) {
                        msg += ' of ' + (state.total / 1024 / 1024).toFixed(1) + 'MB downloaded, ';
                        msg += state.percent + '%';
                    }
                    that._logger.info('progress', msg);
                })
                .then(function () {
                    // Extract archive
                    that._logger.action('extract', path.basename(file), {
                        archive: file,
                        to: that._tempDir
                    });

                    return extract(file, that._tempDir)
                        // Fallback to standard git clone if extraction failed
                        .fail(function (err) {
                            msg =  'Decompression of ' + path.basename(file) + ' failed' + (err.code ? ' with ' + err.code : '') + ', ';
                            that._logger.debug('error', err.message, { error: err });
                            that._logger.warn('retry', msg);

                            return that._cleanTempDir();
                        });
                    // Fallback to standard git clone if download failed
                }, function (err) {
                    msg = 'Download of ' + requestUrl + ' failed' + (err.code ? ' with ' + err.code : '') + ', ';
                    that._logger.debug('error', err.message, { error: err });
                    that._logger.warn('retry', msg);

                    return that._cleanTempDir();
                });
        })
        .fail(function(response){
            var status = response.statusCode;

            // In case we got 404, lets get the full error JSON, and show it to the user
            if(status === 404){
                return ArtifactoryResolver.doArtifactoryRequest(requestUrl, bowerConfig)
                    .then(function (response){
                        console.log("response" + response);
                        return true;
                    })
                    .fail(function(jsonResponse){
                        var err = createError('Tag/branch ' + target + ' does not exist', 'ENORESTARGET');
                        err.details = jsonResponse.message;
                        throw err;
                    });
            }

            if (status < 200 || status >= 300) {
                return createError('Request to ' + requestUrl + ' failed with ' + response.statusCode,
                    'EINVRES');
            }
        });

    return resolve;
};

ArtifactoryResolver.prototype._hasNew = function (canonicalDir, pkgMeta) {
    var requestUrl = this._artifactoryRegistryAddress + '/binaries/' + this._org + '/' + this._repo +
        '.git/' + this._target;

    var oldCacheHeaders = pkgMeta._cacheHeaders || {};
    var reqHeaders = {};

    // If the previous cache headers contain an ETag,
    // send the "If-None-Match" header with it
    if (oldCacheHeaders.ETag) {
        reqHeaders['If-None-Match'] = oldCacheHeaders.ETag;
    }

    var res = ArtifactoryResolver.doArtifactoryHeadRequest(requestUrl, this._config, reqHeaders)
        .then(function (response){
            console.log("response" + response);
            return true;
        })
        .fail(function(response){
            if (response.statusCode === 304) {
                return false;
            }

            return false;
        });

    return res;
}

ArtifactoryResolver.prototype._savePkgMeta = function (meta) {
    // Store collected headers in the package meta
    meta._cacheHeaders = this._collectCacheHeaders(this._response);

    // Store ETAG under _release
    if (meta._cacheHeaders.ETag) {
        meta._release = 'e-tag:' + mout.string.trim(meta._cacheHeaders.ETag.substr(0, 10), '"');
    }

    return Resolver.prototype._savePkgMeta.call(this, meta);
};

ArtifactoryResolver.getOrgRepoPair = function (url) {
    var match;
    match = url.replace(ArtifactoryResolver.ARTIFACTORY_PREFIX, "").split("/")

    if (match.length < 2) {
        return null;
    }

    return {
        org: match[0],
        repo: match[1]
    };
};

ArtifactoryResolver.extractArtifactoryRegistry = function (config){
    var registryUrl;
    registryUrl = config.registry.register;
    if(!registryUrl || registryUrl===Config.DEFAULT_REGISTRY){
        config.registry.search.forEach(function (reg) {
            if(reg.indexOf("artifactory") > -1){
                registryUrl = reg;
            }
        });
    }

    return registryUrl;
}

ArtifactoryResolver.doArtifactoryHeadRequest = function (requestUrl, config, customHeaders){
    var headers = customHeaders || {};
    var remote = url.parse(requestUrl);
    var deferred = Q.defer();

    request.head(requestUrl, {
        proxy: remote.protocol === 'https:' ? config.httpsProxy : config.proxy,
        headers: headers,
        strictSSL: config.strictSsl,
        timeout: config.timeout
    })
        .on('error', function (error){
            throw createError('Request to ' + requestUrl + ' failed: ' + error.message, error.code);
            //deferred.reject();
        })
        .on('response', function(response) {
            var status = response.statusCode;

            if (status < 200 || status >= 300) {
                return deferred.reject(response);
            }

            deferred.resolve(response);
        });

    return deferred.promise;
}

ArtifactoryResolver.doArtifactoryRequest = function (requestUrl, config){
    var headers = {};
    var remote = url.parse(requestUrl);
    var deferred = Q.defer();

    request.get(requestUrl, {
        proxy: remote.protocol === 'https:' ? config.httpsProxy : config.proxy,
        headers: headers,
        strictSSL: config.strictSsl,
        timeout: config.timeout
    })
        .on('error', function (error){
            deferred.reject(createError('Request to ' + requestUrl + ' failed: ' + error.message, error.code));
        })
        .on('data', function (data) {
            var jsonObject = JSON.parse(data);
            deferred.reject(jsonObject.errors[0]);
        })
    /*.on('response', function(response) {
     var status = response.statusCode;

     if(status !== 404){
     deferred.resolve(response)
     }

     *//* if (status < 200 || status >= 300) {
     return deferred.reject(createError('Request to ' + requestUrl + ' failed with ' + response.statusCode,
     'EINVRES'));
     }

     deferred.resolve(response);*//*
     });*/

    return deferred.promise;
}

function collectHeaderFileName(headResponse){
    var contentDisposition = headResponse.headers['content-disposition'];
    contentDisposition = contentDisposition.replace("attachment; filename=", "");
    contentDisposition = contentDisposition.substring(1, contentDisposition.length  - 1);

    return contentDisposition;
}

ArtifactoryResolver.prototype._collectCacheHeaders = function (res) {
    var headers = {};

    // Collect cache headers
    this.constructor._cacheHeaders.forEach(function (name) {
        var value = res.headers[name.toLowerCase()];

        if (value != null) {
            headers[name] = value;
        }
    });

    return headers;
};

ArtifactoryResolver._cacheHeaders = [
    'Content-MD5',
    'ETag',
    'Last-Modified',
    'Content-Language',
    'Content-Length',
    'Content-Type',
    'Content-Disposition'
];

ArtifactoryResolver.ARTIFACTORY_PREFIX = "art://";

module.exports = ArtifactoryResolver;
