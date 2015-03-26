var Q = require('q');
var util = require('util');
var url = require('url');
var mout = require('mout');
var path = require('path');
var request = require('request');
var LRU = require('lru-cache');
var Config = require('bower-config');
var bowerPackage = require('bower-art')
var download = bowerPackage.util.download;
var createError = bowerPackage.util.createError;
var extract = bowerPackage.util.extract;
var Resolver = bowerPackage.resolverBase;
var semver = bowerPackage.util.semver;

function ArtifactoryResolver(decEndpoint, config, logger) {
    var pair;
    Resolver.call(this, decEndpoint, config, logger);

    this._artifactoryRegistryAddress = ArtifactoryResolver.extractArtifactoryRegistry(this._config);

    pair = ArtifactoryResolver.getOrgRepoPair(this._source);
    if (!pair) {
        throw createError('Invalid Artifactory Registry', 'EINVEND', {
            details: this._source + ' does not seem to be a valid Artifactory registry response!'
        });
    }
    this._org = pair.org;
    this._repo = pair.repo;
}

util.inherits(ArtifactoryResolver, Resolver);
mout.object.mixIn(ArtifactoryResolver, Resolver);

// Abstract functions that must be implemented by concrete resolvers
ArtifactoryResolver.prototype._resolve = function () {
    var msg;
    var that = this;
    var requestUrl = this._artifactoryRegistryAddress + '/binaries/' +
        encodeURIComponent(this._org) + '/' +
        encodeURIComponent(this._repo) +
        '.git/' + encodeURIComponent(this._target);

    requestUrl = url.format(requestUrl);

    var artifactoryRemote = url.parse(requestUrl);
    var tempDir = this._tempDir;
    var reqHeaders = {};
    var file = path.join(tempDir, 'archive.tar.gz');

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
                    that._logger.debug('error', state.error.message, {error: state.error});
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
            .then(function (response) {
                that._response = response;
                // Extract archive
                that._logger.action('extract', path.basename(file), {
                    archive: file,
                    to: that._tempDir
                });

                return extract(file, that._tempDir)
                    // Fallback to standard git clone if extraction failed
                    .fail(function (err) {
                        msg = 'Decompression of ' + path.basename(file) + ' failed' + (err.code ? ' with ' + err.code : '') + ', ';
                        that._logger.debug('error', err.message, {error: err});
                        that._logger.warn('retry', msg);

                        return that._cleanTempDir();
                    });
            }, function (err) {
                msg = 'Download of ' + requestUrl + ' failed' + (err.code ? ' with ' + err.code : '') + ', ';
                that._logger.debug('error', err.message, {error: err});
                that._logger.warn('retry', msg);

                return that._cleanTempDir();
            })
            .fail(function (response) {
                var status = response.statusCode;

                // In case we got 404, lets take the full error JSON, and show it to the user
                if (status === 404) {
                    return ArtifactoryResolver.doArtifactoryRequest(requestUrl, bowerConfig)
                        .then(function (response) {
                            var jsonObject = JSON.parse(response);
                            if (jsonObject) {
                                var err = createError('Tag/branch ' + target + ' does not exist', 'ENORESTARGET');
                                err.details = response.message;
                                throw err;
                            }

                            return true;
                        })
                        .fail(function (response) {
                            var err = createError(response.message, 'ENORESTARGET');
                            err.details = response.message;
                            throw err;
                        });
                }

                if (status < 200 || status >= 300) {
                    return createError('Request to ' + requestUrl + ' failed with ' + response.statusCode,
                        'EINVRES');
                }
            });
};

ArtifactoryResolver.prototype._hasNew = function (canonicalDir, pkgMeta) {
    var requestUrl = this._artifactoryRegistryAddress + '/binaries/' +
        encodeURIComponent(this._org) + '/' +
        encodeURIComponent(this._repo) +
        '.git/' + encodeURIComponent(this._target);

    var oldCacheHeaders = pkgMeta._cacheHeaders || {};
    var reqHeaders = {};

    // If the previous cache headers contain an ETag,
    // send the "If-None-Match" header with it
    if (oldCacheHeaders.ETag) {
        reqHeaders['If-None-Match'] = oldCacheHeaders.ETag;
    }

    return ArtifactoryResolver.doArtifactoryHeadRequest(requestUrl, this._config, reqHeaders)
        .then(function () {
            return true;
        })
        .fail(function (response) {
            return response.statusCode !== 304;
        });
};

ArtifactoryResolver.prototype._savePkgMeta = function (meta) {
    if(this._response) {
        // Store collected headers in the package meta
        meta._cacheHeaders = this._collectCacheHeaders(this._response);

        // Store ETAG under _release
        if (meta._cacheHeaders.ETag) {
            meta._release = 'e-tag:' + mout.string.trim(meta._cacheHeaders.ETag.substr(0, 10), '"');
        }
    }
    return Resolver.prototype._savePkgMeta.call(this, meta);
};

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

ArtifactoryResolver.versions = function (source) {
    var value = this._cache.versions.get(source);
    if (value) {
        return Q.resolve(value)
            .then(function () {
                var versions = this._cache.versions.get(source);
                versions = versions.map(function (version) {
                    return version.version;
                });

                return versions;
            }.bind(this));
    }

    value = this.tags(source)
        .then(function (tags) {
            var tag;
            var version;
            var versions = [];

            // For each tag
            for (tag in tags) {
                version = semver.clean(tag);
                if (version) {
                    versions.push({version: version, tag: tag, commit: tags[tag]});
                }
            }

            // Sort them by DESC order
            versions.sort(function (a, b) {
                return semver.rcompare(a.version, b.version);
            });

            this._cache.versions.set(source, versions);

            // Call the function again to keep it DRY
            return this.versions(source);
        }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.versions.set(source, value);

    return value;
};

ArtifactoryResolver.tags = function (source) {
    var value = this._cache.tags.get(source);

    if (value) {
        return Q.resolve(value);
    }

    value = this.refs(source).then(function (refs) {
        var tags = {};

        // For each line in the refs, match only the tags
        refs.forEach(function (line) {
            var match = line.match(/^([a-f0-9]{44})\s+refs\/tags\/(\S+)/);

            if (match && !mout.string.endsWith(match[2], '^{}')) {
                tags[match[2]] = match[1];
            }
        });
        this._cache.tags.set(source, tags);

        return tags;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.tags.set(source, value);

    return value;
};

ArtifactoryResolver.refs = function (source) {
    var config = bowerPackage.config;
    var pair = ArtifactoryResolver.getOrgRepoPair(source);
    var value;

    value = this._cache.refs.get(source);
    if (value) {
        return Q.resolve(value);
    }

    var requestUrl = ArtifactoryResolver.extractArtifactoryRegistry(config) + '/' + pair.org +
        '/' + pair.repo + '.git/' + 'info/refs?service=git-upload-pack';

    value = ArtifactoryResolver.doArtifactoryRequest(requestUrl, config)
        .then(function (response) {
            var refs = response.toString()
                .trim()                         // Trim trailing and leading spaces
                .split(/[\r\n]+/);

            // Update the refs with the actual refs
            this._cache.refs.set(source, refs);

            return refs;
        }.bind(this))
        .fail(function (response) {
            var err = createError(response.message, 'ENORESTARGET');
            err.details = response.message;
            throw err;
        });

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.refs.set(source, value);

    return value;
};

ArtifactoryResolver.getOrgRepoPair = function (source) {
    var match;
    match = source.replace(ArtifactoryResolver.ARTIFACTORY_PREFIX, "").split("/")

    if (match.length < 2) {
        return null;
    }

    return {
        org: match[0],
        repo: match[1]
    };
};

ArtifactoryResolver.extractArtifactoryRegistry = function (config) {
    var registryUrl;
    registryUrl = config.registry.register;
    if (!registryUrl || registryUrl === Config.DEFAULT_REGISTRY) {
        config.registry.search.forEach(function (reg) {
            if (reg.indexOf("artifactory") > -1) {
                registryUrl = reg;
            }
        });
    }

    return registryUrl;
};

ArtifactoryResolver.doArtifactoryHeadRequest = function (requestUrl, config, customHeaders) {
    var headers = customHeaders || {};
    var remote = url.parse(requestUrl);
    var deferred = Q.defer();

    request.head(requestUrl, {
        proxy: remote.protocol === 'https:' ? config.httpsProxy : config.proxy,
        headers: headers,
        strictSSL: config.strictSsl,
        timeout: config.timeout
    })
    .on('error', function (error) {
        throw createError('Request to ' + requestUrl + ' failed: ' + error.message, error.code);
    })
    .on('response', function (response) {
        var status = response.statusCode;

        if (status < 200 || status >= 300) {
            return deferred.reject(response);
        }

        deferred.resolve(response);
    });

    return deferred.promise;
};

ArtifactoryResolver.doArtifactoryRequest = function (requestUrl, config) {
    var headers = {};
    var remote = url.parse(requestUrl);
    var deferred = Q.defer();

    request.get(requestUrl, {
        proxy: remote.protocol === 'https:' ? config.httpsProxy : config.proxy,
        headers: headers,
        strictSSL: config.strictSsl,
        timeout: config.timeout
    })
        .on('error', function (error) {
            deferred.reject(createError('Request to ' + requestUrl + ' failed: ' + error.message, error.code));
        })
        .on('data', function (data) {
            deferred.resolve(data);
        });

    return deferred.promise;
};

ArtifactoryResolver.collectHeaderFileName = function (headResponse) {
    var contentDisposition = headResponse.headers['content-disposition'];
    contentDisposition = contentDisposition.replace("attachment; filename=", "");
    contentDisposition = contentDisposition.substring(1, contentDisposition.length - 1);

    return contentDisposition;
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

ArtifactoryResolver._cache = {
    branches: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    tags: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    versions: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    refs: new LRU({ max: 50, maxAge: 5 * 60 * 1000 })
};

ArtifactoryResolver.ARTIFACTORY_PREFIX = "arti://";

module.exports = ArtifactoryResolver;
