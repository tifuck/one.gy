class _S3Backend(_StorageBackend):
    """S3-compatible storage backend (AWS S3, Backblaze B2, Wasabi, MinIO)."""

    # AUDIT FIX (transient error must not permanently downgrade a node): how long
    # a "provider does not support ChecksumSHA256" verdict is honoured before the
    # capability is re-probed. Without this, one bad response latched the node
    # into size-only verification for the lifetime of the process.
    _CHECKSUM_UNSUPPORTED_RETRY_SECONDS = 3600

    # Error codes that genuinely mean "this provider/endpoint does not implement
    # the ChecksumSHA256 argument". Anything else (throttling, 5xx, expired
    # credentials, timeouts) is TRANSIENT and must not disable checksums.
    _CHECKSUM_UNSUPPORTED_CODES = (
        'InvalidChecksumAlgorithm', 'UnsupportedArgument',
        'XNotImplemented', 'NotImplemented',
    )

    def __init__(self, node_config):
        # AUDIT FIX (finding 15): refuse to construct a backend for a
        # plaintext http:// endpoint unless STORAGE_S3_ALLOW_HTTP explicitly
        # opts in. Enforcing here (not only in the admin routes) means an
        # existing config row can no longer keep replicating credentials and
        # payloads over unencrypted HTTP after the flag policy changed.
        _endpoint_url = str((node_config or {}).get('endpoint_url') or '').strip()
        _scheme_error = _s3_endpoint_scheme_error(_endpoint_url)
        if _scheme_error:
            raise ValueError(_scheme_error)
        self._config = node_config
        self._client = None
        # Track whether this S3 provider supports ChecksumSHA256.
        # None = not yet tested, True = supported, False = not supported (fallback to size-only).
        self._checksum_supported = None
        # Monotonic timestamp of the last "unsupported" verdict, used to allow
        # recovery via periodic re-probe (see _checksum_mode_allowed).
        self._checksum_unsupported_at = None

    def _is_checksum_unsupported_error(self, err):
        """True only when `err` actually means 'ChecksumSHA256 is not supported'.

        AUDIT FIX (transient error must not permanently downgrade a node):
        _S3Backend.stat() previously treated ANY non-404 ClientError on a
        ChecksumMode=ENABLED HEAD as proof the provider lacks checksum support
        and set _checksum_supported=False unconditionally. A throttle, a 503 or
        an expired-credential blip is indistinguishable from a real capability
        gap at that level -- and once flipped, put() stopped sending
        ChecksumSHA256 entirely, so every later upload to that node was accepted
        on size alone. Only a 4xx whose code names an unsupported/invalid
        argument counts as a capability verdict."""
        # boto3's managed (multipart) transfer wraps the ClientError in
        # S3UploadFailedError, which carries no .response of its own.
        while err is not None and not hasattr(err, 'response'):
            err = err.__cause__ or err.__context__
        if err is None:
            return False
        code = ''
        status = None
        try:
            code = str(err.response['Error']['Code'])
        except (AttributeError, KeyError, TypeError):
            code = ''
        try:
            status = err.response['ResponseMetadata']['HTTPStatusCode']
        except (AttributeError, KeyError, TypeError):
            status = None
        # 501 Not Implemented is a capability answer (S3's NotImplemented), not
        # a transient failure; every other 5xx is.
        if status is not None and not (400 <= int(status) < 500) and int(status) != 501:
            return False  # 5xx / network-ish: transient by definition
        haystack = (code or '').strip()
        return haystack in self._CHECKSUM_UNSUPPORTED_CODES

    def _mark_checksum_unsupported(self, context):
        self._checksum_supported = False
        self._checksum_unsupported_at = time.monotonic()
        endpoint = self._config.get('endpoint_url', 'AWS S3')
        print(f'[STORAGE] [WARNING] S3 provider ({endpoint}) does not support ChecksumSHA256 '
              f'({context}) — falling back to SIZE-ONLY verification for up to '
              f'{self._CHECKSUM_UNSUPPORTED_RETRY_SECONDS}s, then re-probing')

    def _checksum_mode_allowed(self):
        """True when this backend may still ask for ChecksumSHA256.

        A prior 'unsupported' verdict expires after
        _CHECKSUM_UNSUPPORTED_RETRY_SECONDS so a node that was downgraded by a
        misdiagnosed error (or a provider that has since gained support) can
        recover full integrity verification without a process restart."""
        if self._checksum_supported is not False:
            return True
        if self._checksum_unsupported_at is None:
            return False
        if (time.monotonic() - self._checksum_unsupported_at) < self._CHECKSUM_UNSUPPORTED_RETRY_SECONDS:
            return False
        endpoint = self._config.get('endpoint_url', 'AWS S3')
        print(f'[STORAGE] Re-probing ChecksumSHA256 support on S3 provider ({endpoint}) '
              f'after the size-only fallback window expired')
        self._checksum_supported = None
        self._checksum_unsupported_at = None
        return True

    def _get_client(self):
        if self._client is not None:
            return self._client
        import boto3
        from botocore.config import Config as BotoConfig
        endpoint_url = self._config.get('endpoint_url')
        access_key = self._config['access_key']
        secret_key = self._config['secret_key']
        region = self._config.get('region', 'us-east-1')
        self._client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=BotoConfig(signature_version='s3v4', retries={'max_attempts': 3}, connect_timeout=10, read_timeout=60),
        )
        return self._client

    def _key(self, category, file_id):
        # AUDIT FIX M1: strict validation of category and file_id to prevent
        # path traversal/odd keys when interacting with the S3 API.
        # The `''` sentinel is intentionally used by list_files() to compute
        # the bucket prefix; allow only that exact empty-string case.
        _validate_storage_category(category)
        if file_id != '':
            _validate_storage_file_id(file_id)
        prefix = self._config.get('prefix', '')
        if prefix and not prefix.endswith('/'):
            prefix += '/'
        return f'{prefix}{category}/{file_id}'

    @property
    def _bucket(self):
        return self._config['bucket']

    def _is_backblaze_b2(self):
        provider = str(self._config.get('provider') or '').strip().lower()
        if provider in ('b2', 'backblaze', 'backblaze-b2', 'backblazeb2'):
            return True
        endpoint = str(self._config.get('endpoint_url') or '').strip().lower()
        return 'backblazeb2.com' in endpoint

    def _is_permanent_delete_enabled(self):
        configured = self._config.get('permanent_delete')
        if configured is not None:
            if isinstance(configured, str):
                return configured.strip().lower() in ('1', 'true', 'yes', 'on')
            return bool(configured)
        return self._is_backblaze_b2()

    def _list_object_versions_for_key(self, key):
        client = self._get_client()
        versions = []
        key_marker = None
        version_marker = None

        while True:
            kwargs = {
                'Bucket': self._bucket,
                'Prefix': key,
                'MaxKeys': 1000,
            }
            if key_marker is not None:
                kwargs['KeyMarker'] = key_marker
            if version_marker is not None:
                kwargs['VersionIdMarker'] = version_marker

            response = client.list_object_versions(**kwargs)
            for item in response.get('Versions', []):
                if item.get('Key') == key and item.get('VersionId'):
                    versions.append(item['VersionId'])
            for item in response.get('DeleteMarkers', []):
                if item.get('Key') == key and item.get('VersionId'):
                    versions.append(item['VersionId'])

            if not response.get('IsTruncated'):
                break

            key_marker = response.get('NextKeyMarker')
            version_marker = response.get('NextVersionIdMarker')
            if key_marker is None:
                break

        return versions

    def _latest_object_version_id(self, key):
        """Return the VersionId of the CURRENT version of `key`, or None.

        AUDIT FIX (unpaginated version lookup): this used to issue a SINGLE
        non-paginated list_object_versions(Prefix=key, MaxKeys=1000) and return
        None whenever the latest version was not on page one (easy with a shared
        key prefix, or an object with >1000 versions). _delete_latest_object_version
        then fell back to a plain delete_object(), which on a VERSIONED bucket
        adds a delete marker instead of permanently removing the object -- so the
        payload silently survived a "permanent" delete and kept billing storage.
        Paginate until the current version is found."""
        client = self._get_client()
        key_marker = None
        version_marker = None
        while True:
            kwargs = {
                'Bucket': self._bucket,
                'Prefix': key,
                'MaxKeys': 1000,
            }
            if key_marker is not None:
                kwargs['KeyMarker'] = key_marker
            if version_marker is not None:
                kwargs['VersionIdMarker'] = version_marker
            response = client.list_object_versions(**kwargs)
            for collection_name in ('Versions', 'DeleteMarkers'):
                for item in response.get(collection_name, []):
                    if item.get('Key') == key and item.get('IsLatest') and item.get('VersionId'):
                        return item['VersionId']
            if not response.get('IsTruncated'):
                return None
            key_marker = response.get('NextKeyMarker')
            version_marker = response.get('NextVersionIdMarker')
            if key_marker is None:
                return None

    def _delete_all_object_versions(self, key):
        client = self._get_client()
        version_ids = self._list_object_versions_for_key(key)
        if not version_ids:
            try:
                client.head_object(Bucket=self._bucket, Key=key)
            except Exception as e:
                try:
                    from botocore.exceptions import ClientError as _ClientError
                    if isinstance(e, _ClientError):
                        status = e.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
                        code = e.response.get('Error', {}).get('Code')
                        if status == 404 or code in ('404', 'NoSuchKey', 'NotFound'):
                            return 0
                except (ImportError, AttributeError):
                    pass
                raise
            versioning = client.get_bucket_versioning(Bucket=self._bucket)
            if versioning.get('Status') in ('Enabled', 'Suspended'):
                raise IOError(
                    f'S3 permanent delete found an existing object but no versions for {key}'
                )
            client.delete_object(Bucket=self._bucket, Key=key)
            try:
                client.head_object(Bucket=self._bucket, Key=key)
            except Exception as e:
                try:
                    from botocore.exceptions import ClientError as _ClientError
                    if isinstance(e, _ClientError):
                        status = e.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
                        code = e.response.get('Error', {}).get('Code')
                        if status == 404 or code in ('404', 'NoSuchKey', 'NotFound'):
                            return 1
                except (ImportError, AttributeError):
                    pass
                raise
            raise IOError(f'S3 object still exists after permanent delete: {key}')
        deleted = 0
        for version_id in version_ids:
            client.delete_object(Bucket=self._bucket, Key=key, VersionId=version_id)
            deleted += 1
        return deleted

    def _delete_latest_object_version(self, key, version_id=None):
        client = self._get_client()
        if self._is_permanent_delete_enabled():
            if version_id is None:
                version_id = self._latest_object_version_id(key)
            if not version_id:
                raise IOError(f'S3 permanent cleanup could not identify the uploaded version for {key}')
            client.delete_object(Bucket=self._bucket, Key=key, VersionId=version_id)
            return
        client.delete_object(Bucket=self._bucket, Key=key)

    def list_object_versions(self, category):
        client = self._get_client()
        prefix = self._key(category, '')
        result = []
        key_marker = None
        version_marker = None

        while True:
            kwargs = {
                'Bucket': self._bucket,
                'Prefix': prefix,
                'MaxKeys': 1000,
            }
            if key_marker is not None:
                kwargs['KeyMarker'] = key_marker
            if version_marker is not None:
                kwargs['VersionIdMarker'] = version_marker

            response = client.list_object_versions(**kwargs)
            for item in response.get('Versions', []):
                key = item.get('Key')
                if not key or not key.startswith(prefix):
                    continue
                file_id = key[len(prefix):]
                if not file_id:
                    continue
                result.append({
                    'key': key,
                    'file_id': file_id,
                    'version_id': item.get('VersionId'),
                    'is_latest': bool(item.get('IsLatest')),
                    'is_delete_marker': False,
                    'size': int(item.get('Size') or 0),
                })
            for item in response.get('DeleteMarkers', []):
                key = item.get('Key')
                if not key or not key.startswith(prefix):
                    continue
                file_id = key[len(prefix):]
                if not file_id:
                    continue
                result.append({
                    'key': key,
                    'file_id': file_id,
                    'version_id': item.get('VersionId'),
                    'is_latest': bool(item.get('IsLatest')),
                    'is_delete_marker': True,
                    'size': 0,
                })

            if not response.get('IsTruncated'):
                break

            key_marker = response.get('NextKeyMarker')
            version_marker = response.get('NextVersionIdMarker')
            if key_marker is None:
                break

        return result

    def _encode_sha256_for_s3(self, hex_digest):
        """Convert a SHA-256 hex digest to the base64 format S3 expects for ChecksumSHA256."""
        import base64 as _b64
        return _b64.b64encode(bytes.fromhex(hex_digest)).decode('ascii')

    def checksum(self, category, file_id):
        """Return the object's SHA-256 hex digest when the provider exposes it."""
        try:
            client = self._get_client()
            head_kwargs = {'Bucket': self._bucket, 'Key': self._key(category, file_id)}
            if self._checksum_mode_allowed():
                head_kwargs['ChecksumMode'] = 'ENABLED'
            resp = client.head_object(**head_kwargs)
            checksum_b64 = resp.get('ChecksumSHA256')
            if not checksum_b64 or '-' in checksum_b64:
                return None
            return base64.b64decode(checksum_b64).hex()
        except Exception:
            return None

    def put(self, category, file_id, local_path, verify_checksum=False, local_hash=None):
        """Upload a file to S3 with post-upload size verification.
        If verify_checksum=True and local_hash is provided, uses S3 ChecksumSHA256
        for upload integrity (S3 rejects the upload if hash mismatches the received bytes).
        Falls back gracefully for S3-compatible providers that don't support checksums."""
        if _is_internal_storage_artifact(file_id):
            raise ValueError(f'REFUSING TO UPLOAD INTERNAL STORAGE ARTIFACT: {category}/{file_id}')
        client = self._get_client()
        key = self._key(category, file_id)
        local_size = os.path.getsize(local_path)
        _use_checksum = bool(verify_checksum and local_hash and self._checksum_mode_allowed())
        if local_size > 100 * 1024 * 1024:
            # Large file: multipart upload
            import boto3
            from boto3.s3.transfer import TransferConfig
            from botocore.config import Config as BotoConfig
            # AUDIT FIX (S3 multipart timeouts): previously this resource was
            # created with NO timeout config, unlike the cached client (which has
            # connect_timeout/read_timeout/retries). A hung endpoint mid-upload
            # could block the replication worker thread indefinitely. Use a
            # bounded connect timeout + a generous read timeout sized for 64 MB
            # parts, with botocore's automatic retries.
            s3_resource = boto3.resource(
                's3',
                endpoint_url=self._config.get('endpoint_url'),
                aws_access_key_id=self._config['access_key'],
                aws_secret_access_key=self._config['secret_key'],
                region_name=self._config.get('region', 'us-east-1'),
                config=BotoConfig(signature_version='s3v4', retries={'max_attempts': 3},
                                  connect_timeout=10, read_timeout=300),
            )
            config = TransferConfig(multipart_threshold=100 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
            extra_args = {}
            if _use_checksum:
                extra_args['ChecksumAlgorithm'] = 'SHA256'
            try:
                s3_resource.Bucket(self._bucket).upload_file(
                    local_path, key, Config=config,
                    ExtraArgs=extra_args if extra_args else None,
                )
                if _use_checksum and self._checksum_supported is None:
                    self._checksum_supported = True
            except Exception as upload_err:
                # Check if the error is because the provider doesn't support checksums
                if _use_checksum and self._checksum_supported is None:
                    if self._is_checksum_unsupported_error(upload_err):
                        self._mark_checksum_unsupported('multipart upload rejected ChecksumAlgorithm')
                        _use_checksum = False
                        # Retry without checksum
                        s3_resource.Bucket(self._bucket).upload_file(local_path, key, Config=config)
                    else:
                        raise
                else:
                    raise
        else:
            # Small file: single put_object
            put_kwargs = {'Bucket': self._bucket, 'Key': key}
            if _use_checksum:
                put_kwargs['ChecksumAlgorithm'] = 'SHA256'
                put_kwargs['ChecksumSHA256'] = self._encode_sha256_for_s3(local_hash)
            try:
                with open(local_path, 'rb') as f:
                    put_kwargs['Body'] = f
                    client.put_object(**put_kwargs)
                if _use_checksum and self._checksum_supported is None:
                    self._checksum_supported = True
            except Exception as upload_err:
                # Check if the error is because the provider doesn't support checksums
                if _use_checksum and self._checksum_supported is None:
                    if self._is_checksum_unsupported_error(upload_err):
                        self._mark_checksum_unsupported('put_object rejected ChecksumSHA256')
                        _use_checksum = False
                        # Retry without checksum
                        with open(local_path, 'rb') as f:
                            client.put_object(Bucket=self._bucket, Key=key, Body=f)
                    else:
                        raise
                else:
                    raise
        # Post-upload verification: size check + optional checksum comparison
        # AUDIT FIX (backend honesty): track whether the object's hash was
        # actually confirmed end-to-end (single-part ChecksumSHA256 match, or
        # multipart download-back match). Size-only acceptance leaves this False
        # so the caller does NOT record a checksum it cannot vouch for.
        _checksum_confirmed = False
        try:
            head_kwargs = {'Bucket': self._bucket, 'Key': key}
            if self._checksum_supported:
                head_kwargs['ChecksumMode'] = 'ENABLED'
            head = client.head_object(**head_kwargs)
            remote_size = head['ContentLength']
            if remote_size != local_size:
                # Clean up the bad upload
                try:
                    self._delete_latest_object_version(key, head.get('VersionId'))
                except Exception as cleanup_err:
                    print(f'[STORAGE] Failed to remove bad S3 upload {key}: {cleanup_err}')
                raise IOError(f'S3 upload size mismatch: local={local_size}, remote={remote_size}')
            # AUDIT FIX (F5 visibility): a >100 MB multipart upload whose provider
            # cannot return a comparable whole-file SHA-256 is accepted on the
            # size check alone. Surface that explicitly so operators know the
            # integrity guarantee for large objects on this node is size-only.
            if local_size > 100 * 1024 * 1024 and not (verify_checksum and local_hash and self._checksum_supported):
                print(f'[STORAGE] [WARNING] S3 multipart object {category}/{file_id} '
                      f'({local_size} bytes) accepted with SIZE-ONLY verification '
                      f'(no comparable SHA-256 available on this provider/config)')
            # Verify checksum from head_object response (single-part uploads only)
            if verify_checksum and local_hash and self._checksum_supported:
                remote_checksum = head.get('ChecksumSHA256')
                if remote_checksum:
                    expected_b64 = self._encode_sha256_for_s3(local_hash)
                    # For multipart, S3 returns a composite checksum like "base64=-N" — skip comparison
                    if '-' not in remote_checksum and remote_checksum != expected_b64:
                        try:
                            self._delete_latest_object_version(key, head.get('VersionId'))
                        except Exception as cleanup_err:
                            print(f'[STORAGE] Failed to remove bad S3 upload {key}: {cleanup_err}')
                        raise IOError(
                            f'S3 SHA-256 mismatch after upload: local={expected_b64}, remote={remote_checksum}'
                        )
                    # Single-part object with a matching server-side SHA-256 is
                    # confirmed end-to-end (S3 rejects byte-mismatched uploads).
                    if '-' not in remote_checksum:
                        _checksum_confirmed = True
                    # AUDIT FIX P1-1: For multipart uploads, S3 returns a
                    # composite checksum (contains '-') that we cannot
                    # compare against the whole-file hash. Size check alone
                    # does not catch length-preserving corruption introduced
                    # during the multipart transfer. When the local source is
                    # still available, do a lightweight download-back
                    # verification: re-head the object, download to a temp
                    # file, hash it, and compare against local_hash. This
                    # catches byte-level corruption that size checks miss.
                    # Gated by the s3_multipart_verify_write setting (default
                    # true) so operators can disable it if egress cost is a
                    # concern for very large files.
                    if '-' in remote_checksum and local_size > 100 * 1024 * 1024:
                        _mp_verify = True
                        try:
                            _mp_verify = str(get_setting_value('s3_multipart_verify_write') or 'true').lower() in ('true', '1', 'yes')
                        except Exception:
                            pass
                        if _mp_verify:
                            _dl_tmp = None
                            try:
                                _dl_fd, _dl_tmp = tempfile.mkstemp(
                                    prefix='.s3_verify_',
                                    dir=os.path.dirname(local_path) or None,
                                )
                                os.close(_dl_fd)
                                client.download_file(self._bucket, key, _dl_tmp)
                                _dl_hash = _sha256_file(_dl_tmp)
                                if _dl_hash != local_hash:
                                    try:
                                        self._delete_latest_object_version(key, head.get('VersionId'))
                                    except Exception as cleanup_err:
                                        print(f'[STORAGE] Failed to remove bad S3 upload {key}: {cleanup_err}')
                                    raise IOError(
                                        f'S3 multipart SHA-256 mismatch after download-back verify: '
                                        f'local={local_hash[:16]}..., downloaded={_dl_hash[:16]}...'
                                    )
                                # Multipart object fully re-hashed and matched.
                                _checksum_confirmed = True
                            except IOError:
                                raise
                            except Exception as _dl_err:
                                print(f'[STORAGE] S3 multipart download-back verify failed for '
                                      f'{category}/{file_id} (non-fatal): {_dl_err}')
                            finally:
                                if _dl_tmp:
                                    try:
                                        os.remove(_dl_tmp)
                                    except OSError:
                                        pass
                        else:
                            print(f'[STORAGE] [WARNING] S3 multipart object {category}/{file_id} '
                                  f'({local_size} bytes) accepted with SIZE-ONLY verification — '
                                  f's3_multipart_verify_write is disabled, so length-preserving '
                                  f'corruption during the multipart transfer is not detected')
        except IOError:
            raise
        except Exception as e:
            # AUDIT FIX P1-2: when integrity verification is requested
            # (replication_verify_checksum enabled), an unverifiable upload must
            # NOT be silently accepted. If head_object fails we cannot confirm
            # the object's size/checksum, so we raise — the replication cycle
            # then records a failed attempt and retries instead of marking the
            # replica 'synced' on trust. When verification is disabled we keep the
            # previous best-effort behaviour (the definitive size-mismatch branch
            # above still raises regardless).
            # AUDIT FIX (unverified upload must not report success): the
            # `verify_checksum is False` branch used to print "non-fatal" and
            # `return False`, which _replicate_single_item read as a SUCCESSFUL
            # transfer ('ok') and then recorded result['checksum'] for -- so a
            # replica row asserted a checksum for bytes whose very EXISTENCE and
            # SIZE had never been confirmed. head_object failing means we know
            # nothing about the object, which is never a success. Fail the upload
            # in BOTH modes so the replica stays pending and is retried.
            print(f'[STORAGE] [WARNING] S3 post-upload verification could not complete for '
                  f'{category}/{file_id}; failing upload so it is retried: {e}')
            raise IOError(f'S3 post-upload verification failed for {category}/{file_id}: {e}')
        # AUDIT FIX (backend honesty): True only when the hash was confirmed
        # end-to-end; multipart accepted on size-only (verify disabled or
        # download-back failure) returns False so it is treated as unverified.
        return _checksum_confirmed

    def get(self, category, file_id, local_path, verify_checksum=False):
        """Download a file from S3 with size verification and atomic local write.
        If verify_checksum=True, also compares the downloaded file's SHA-256 against
        the ChecksumSHA256 stored in S3 (if present). Silently skips hash check
        for objects uploaded without ChecksumSHA256 (legacy objects)."""
        client = self._get_client()
        key = self._key(category, file_id)
        # Get expected size (and checksum if available) first
        head_kwargs = {'Bucket': self._bucket, 'Key': key}
        if self._checksum_supported:
            head_kwargs['ChecksumMode'] = 'ENABLED'
        head = client.head_object(**head_kwargs)
        expected_size = head['ContentLength']
        remote_checksum_b64 = head.get('ChecksumSHA256') if verify_checksum else None
        # Download to a UNIQUE temp sibling first, then atomic rename (matches
        # SSH backend pattern). AUDIT FIX (finding 12): a fixed '.s3_tmp' name
        # collided between concurrent downloads of the same destination.
        tmp_local = _unique_download_tmp_path(local_path)
        try:
            client.download_file(self._bucket, key, tmp_local)
            local_size = os.path.getsize(tmp_local)
            if local_size != expected_size:
                try:
                    os.remove(tmp_local)
                except OSError:
                    pass
                raise IOError(f'S3 size mismatch after download: expected={expected_size}, got={local_size}')
            # Verify SHA-256 against S3's stored checksum (if object was uploaded with ChecksumSHA256)
            if verify_checksum and remote_checksum_b64 and '-' not in remote_checksum_b64:
                local_hash = _sha256_file(tmp_local)
                local_b64 = self._encode_sha256_for_s3(local_hash)
                if local_b64 != remote_checksum_b64:
                    try:
                        os.remove(tmp_local)
                    except OSError:
                        pass
                    raise IOError(
                        f'S3 SHA-256 mismatch after download: local={local_b64}, remote={remote_checksum_b64}'
                    )
            os.replace(tmp_local, local_path)
        except Exception:
            try:
                os.remove(tmp_local)
            except OSError:
                pass
            raise

    def delete(self, category, file_id):
        client = self._get_client()
        key = self._key(category, file_id)
        try:
            if self._is_permanent_delete_enabled():
                self._delete_all_object_versions(key)
                return
            client.delete_object(Bucket=self._bucket, Key=key)
        except Exception as e:
            try:
                from botocore.exceptions import ClientError as _ClientError
                if isinstance(e, _ClientError) and e.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                    return
            except (ImportError, KeyError, AttributeError):
                pass
            raise

    def exists(self, category, file_id):
        try:
            client = self._get_client()
            client.head_object(Bucket=self._bucket, Key=self._key(category, file_id))
            return True
        except Exception:
            return False

    def exists_verified(self, category, file_id):
        """Like exists() but raises on connection errors instead of returning False.
        Returns True if found, False if confirmed missing (404).
        Raises Exception if the remote is unreachable (cannot determine status)."""
        import botocore.exceptions as _botoexc
        client = self._get_client()
        try:
            client.head_object(Bucket=self._bucket, Key=self._key(category, file_id))
            return True
        except client.exceptions.NoSuchKey:
            return False
        except _botoexc.ClientError as e:
            if e.response['ResponseMetadata']['HTTPStatusCode'] == 404:
                return False
            raise  # Non-404 error = connectivity/auth problem

    def size(self, category, file_id):
        try:
            client = self._get_client()
            resp = client.head_object(Bucket=self._bucket, Key=self._key(category, file_id))
            return resp['ContentLength']
        except Exception:
            return None

    def stat(self, category, file_id, want_checksum=False):
        """Existence + size + (optional) SHA-256 from a SINGLE head_object.

        S3 COST FIX: callers used to issue 2-3 separate HEAD requests per object
        (exists_verified() + size() + checksum()), each a billable S3 HEAD. A
        single head_object response already carries ContentLength and (with
        ChecksumMode=ENABLED) ChecksumSHA256, so this collapses them into one
        request with identical verification coverage.

        Returns {'exists': bool, 'size': int|None, 'checksum': hexstr|None}.
        Mirrors exists_verified() semantics: a confirmed-missing object (HTTP
        404) returns exists=False, while a connectivity/auth error RAISES so the
        caller can distinguish "missing" from "could not determine" and avoid a
        false corruption verdict."""
        import botocore.exceptions as _botoexc
        client = self._get_client()
        key = self._key(category, file_id)
        use_checksum = bool(want_checksum and self._checksum_mode_allowed())
        head_kwargs = {'Bucket': self._bucket, 'Key': key}
        if use_checksum:
            head_kwargs['ChecksumMode'] = 'ENABLED'
        try:
            resp = client.head_object(**head_kwargs)
        except client.exceptions.NoSuchKey:
            return {'exists': False, 'size': None, 'checksum': None}
        except _botoexc.ClientError as e:
            status = None
            try:
                status = e.response['ResponseMetadata']['HTTPStatusCode']
            except (KeyError, TypeError):
                pass
            if status == 404:
                return {'exists': False, 'size': None, 'checksum': None}
            # AUDIT FIX (transient error must not permanently downgrade a node):
            # a provider that does not understand ChecksumMode rejects the
            # request with a specific 4xx code. Previously ANY non-404
            # ClientError here retried without the checksum and then
            # UNCONDITIONALLY set _checksum_supported=False -- so one throttle,
            # 503 or expired-credential blip permanently degraded the node to
            # size-only verification, and every later upload to it recorded an
            # unconfirmed checksum. Only a genuine "unsupported argument" error
            # is now treated as a capability verdict; everything else is
            # transient, so the checksum capability is left untouched and the
            # error is re-raised for the caller to skip this pass.
            if use_checksum and self._is_checksum_unsupported_error(e):
                try:
                    resp = client.head_object(Bucket=self._bucket, Key=key)
                except client.exceptions.NoSuchKey:
                    return {'exists': False, 'size': None, 'checksum': None}
                except _botoexc.ClientError as e2:
                    status2 = None
                    try:
                        status2 = e2.response['ResponseMetadata']['HTTPStatusCode']
                    except (KeyError, TypeError):
                        pass
                    if status2 == 404:
                        return {'exists': False, 'size': None, 'checksum': None}
                    raise
                if self._checksum_supported is None:
                    self._mark_checksum_unsupported('head_object rejected ChecksumMode')
                use_checksum = False
            else:
                raise
        size = resp.get('ContentLength')
        checksum = None
        if use_checksum:
            checksum_b64 = resp.get('ChecksumSHA256')
            if checksum_b64 and '-' not in checksum_b64:
                try:
                    checksum = base64.b64decode(checksum_b64).hex()
                except Exception:
                    checksum = None
        return {'exists': True, 'size': size, 'checksum': checksum}

    def list_files(self, category):
        try:
            client = self._get_client()
            prefix = self._key(category, '')
            result = []
            paginator = client.get_paginator('list_objects_v2')
            for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
                for obj in page.get('Contents', []):
                    key = obj['Key']
                    file_id = key[len(prefix):]
                    if file_id:
                        result.append(file_id)
            return result
        except Exception as e:
            # Never report a failed listing as an empty one.
            raise IOError(f'S3 listing failed for {category}: {e}') from e

    def health_check(self):
        _hc_errors = []
        client = self._get_client()
        # Tier 1: head_bucket — standard S3 (AWS, B2, Wasabi, MinIO)
        try:
            client.head_bucket(Bucket=self._bucket)
            return True
        except Exception as e:
            _hc_errors.append(f'head_bucket={e}')
        # Tier 2: bare list_objects_v2 — providers that support bucket listing
        try:
            client.list_objects_v2(Bucket=self._bucket, MaxKeys=1)
            return True
        except Exception as e:
            _hc_errors.append(f'list_objects={e}')
        # Tier 3: put/delete probe — for providers where bucket-level APIs are
        # broken but object-level put/get works (e.g. Contabo with bucket name
        # embedded in the endpoint URL, causing bucket-level ops to 404)
        try:
            probe_key = self._key('files', '.health_probe')
            client.put_object(Bucket=self._bucket, Key=probe_key, Body=b'ok')
            if self._is_permanent_delete_enabled():
                self._delete_all_object_versions(probe_key)
            else:
                client.delete_object(Bucket=self._bucket, Key=probe_key)
            return True
        except Exception as e:
            _hc_errors.append(f'put_probe={e}')
        print(f'[STORAGE] S3 health check failed for bucket {self._bucket}: {", ".join(_hc_errors)}')
        return False


class ReplicaSessionRollbackError(RuntimeError):
    """Raised when replica bookkeeping rolled back the shared DB session.

    A session-wide rollback expunges every pending object in the session --
    including an in-flight upload's uncommitted File row. Callers with
    uncommitted work must ABORT (fail loudly + clean up artifacts) instead of
    committing whatever survived: committing an empty session would answer
    HTTP 200 with management/download tokens for a row that was never
    persisted. AUDIT FIX H3."""


