package app.nikkisync.mobile.model;

import java.util.List;

public final class Models {
    private Models() {}

    public static final class PairingPayload {
        private final List<String> hosts;
        private final String serverId, host, token, expiresAt, tlsFingerprintSha256;
        private final int port, protocolVersion;
        public PairingPayload(String serverId, String host, int port, String token, int protocolVersion, String expiresAt, String tlsFingerprintSha256) {
            this(serverId,host,port,token,protocolVersion,expiresAt,tlsFingerprintSha256,List.of(host));
        }
        public PairingPayload(String serverId,String host,int port,String token,int protocolVersion,String expiresAt,String tlsFingerprintSha256,List<String> hosts){
            this.hosts=app.nikkisync.mobile.net.EndpointCandidates.normalize(host,hosts);
            this.serverId = serverId; this.host = host; this.port = port; this.token = token;
            this.protocolVersion = protocolVersion; this.expiresAt = expiresAt; this.tlsFingerprintSha256 = tlsFingerprintSha256;
        }
        public String serverId() { return serverId; }
        public String host() { return host; }
        public List<String> hosts() { return hosts; }
        public int port() { return port; }
        public String token() { return token; }
        public int protocolVersion() { return protocolVersion; }
        public String expiresAt() { return expiresAt; }
        public String tlsFingerprintSha256() { return tlsFingerprintSha256; }
    }

    public static final class PairedServer {
        private final List<String> hosts;
        private final String serverId, serverName, host, tlsFingerprintSha256, serverPublicKey, deviceCredential;
        private final int port;
        private final long lastRevision;
        public PairedServer(String serverId, String serverName, String host, int port, String tlsFingerprintSha256,
                            String serverPublicKey, String deviceCredential, long lastRevision) {
            this(serverId,serverName,host,port,tlsFingerprintSha256,serverPublicKey,deviceCredential,lastRevision,List.of(host));
        }
        private PairedServer(String serverId,String serverName,String host,int port,String tlsFingerprintSha256,
                             String serverPublicKey,String deviceCredential,long lastRevision,List<String> hosts){
            this.hosts=app.nikkisync.mobile.net.EndpointCandidates.normalize(host,hosts);
            this.serverId = serverId; this.serverName = serverName; this.host = host; this.port = port;
            this.tlsFingerprintSha256 = tlsFingerprintSha256; this.serverPublicKey = serverPublicKey;
            this.deviceCredential = deviceCredential; this.lastRevision = lastRevision;
        }
        public String serverId() { return serverId; }
        public String serverName() { return serverName; }
        public String host() { return host; }
        public List<String> hosts() { return hosts; }
        public int port() { return port; }
        public String tlsFingerprintSha256() { return tlsFingerprintSha256; }
        public String serverPublicKey() { return serverPublicKey; }
        public String deviceCredential() { return deviceCredential; }
        public long lastRevision() { return lastRevision; }
        public PairedServer withEndpoint(String newHost, int newPort) {
            return new PairedServer(serverId, serverName, newHost, newPort, tlsFingerprintSha256, serverPublicKey, deviceCredential, lastRevision,hosts);
        }
        public PairedServer withRevision(long revision) {
            return new PairedServer(serverId, serverName, host, port, tlsFingerprintSha256, serverPublicKey, deviceCredential, revision,hosts);
        }
        public PairedServer withHosts(List<String> values){return new PairedServer(serverId,serverName,host,port,tlsFingerprintSha256,serverPublicKey,deviceCredential,lastRevision,values);}
    }

    public static final class AssetSummary {
        private final String assetId, type, state, capturedAt, uid, thumbnailResourceId, previewResourceId;
        private final String gameVersion, gameVersionSource;
        private final String thumbnailSha256, previewSha256, fullPreviewResourceId, fullPreviewSha256;
        private final String mediaFingerprint;
        private String sourcePath,sourceFolder;
        private Long sizeBytes;
        private final long revision;
        private final Integer width, height;
        private final boolean hasMotion, hasMetadata;
        public AssetSummary(String assetId, String type, String state, String capturedAt, String uid, long revision,
                            Integer width, Integer height, boolean hasMotion, boolean hasMetadata,
                            String thumbnailResourceId, String previewResourceId,
                            String gameVersion, String gameVersionSource) {
            this(assetId,type,state,capturedAt,uid,revision,width,height,hasMotion,hasMetadata,
                thumbnailResourceId,previewResourceId,gameVersion,gameVersionSource,null,null,null,null);
        }
        public AssetSummary(String assetId, String type, String state, String capturedAt, String uid, long revision,
                            Integer width, Integer height, boolean hasMotion, boolean hasMetadata,
                            String thumbnailResourceId, String previewResourceId, String gameVersion, String gameVersionSource,
                            String thumbnailSha256, String previewSha256, String fullPreviewResourceId, String fullPreviewSha256) {
            this(assetId,type,state,capturedAt,uid,revision,width,height,hasMotion,hasMetadata,thumbnailResourceId,previewResourceId,
                gameVersion,gameVersionSource,thumbnailSha256,previewSha256,fullPreviewResourceId,fullPreviewSha256,null);
        }
        public AssetSummary(String assetId, String type, String state, String capturedAt, String uid, long revision,
                            Integer width, Integer height, boolean hasMotion, boolean hasMetadata,
                            String thumbnailResourceId, String previewResourceId, String gameVersion, String gameVersionSource,
                            String thumbnailSha256, String previewSha256, String fullPreviewResourceId, String fullPreviewSha256,String mediaFingerprint) {
            this.assetId = assetId; this.type = type; this.state = state; this.capturedAt = capturedAt; this.uid = uid;
            this.revision = revision; this.width = width; this.height = height; this.hasMotion = hasMotion;
            this.hasMetadata = hasMetadata; this.thumbnailResourceId = thumbnailResourceId; this.previewResourceId = previewResourceId;
            this.gameVersion = gameVersion; this.gameVersionSource = gameVersionSource;
            this.thumbnailSha256=thumbnailSha256;this.previewSha256=previewSha256;
            this.fullPreviewResourceId=fullPreviewResourceId;this.fullPreviewSha256=fullPreviewSha256;
            this.mediaFingerprint=mediaFingerprint;
        }
        public String assetId() { return assetId; }
        public String type() { return type; }
        public boolean isVideo() { return "video".equals(type); }
        public String state() { return state; }
        public String capturedAt() { return capturedAt; }
        public String uid() { return uid; }
        public long revision() { return revision; }
        public Integer width() { return width; }
        public Integer height() { return height; }
        public boolean hasMotion() { return hasMotion; }
        public boolean hasMetadata() { return hasMetadata; }
        public String thumbnailResourceId() { return thumbnailResourceId; }
        public String previewResourceId() { return previewResourceId; }
        public String gameVersion() { return gameVersion; }
        public String gameVersionSource() { return gameVersionSource; }
        public String thumbnailSha256(){return thumbnailSha256;}
        public String previewSha256(){return previewSha256;}
        public String fullPreviewResourceId(){return fullPreviewResourceId;}
        public String fullPreviewSha256(){return fullPreviewSha256;}
        public String mediaFingerprint(){return mediaFingerprint;}
        public String sourcePath(){return sourcePath;}
        public String sourceFolder(){return sourceFolder;}
        public Long sizeBytes(){return sizeBytes;}
        public AssetSummary withSource(String path,String folder,Long size){
            AssetSummary copy=new AssetSummary(assetId,type,state,capturedAt,uid,revision,width,height,hasMotion,hasMetadata,thumbnailResourceId,previewResourceId,gameVersion,gameVersionSource,thumbnailSha256,previewSha256,fullPreviewResourceId,fullPreviewSha256,mediaFingerprint);
            copy.sourcePath=path;copy.sourceFolder=folder;copy.sizeBytes=size;return copy;
        }
    }

    public static final class AssetPage {
        private final List<AssetSummary> items;
        private final String nextCursor;
        private final long libraryRevision;
        public AssetPage(List<AssetSummary> items, String nextCursor, long libraryRevision) {
            this.items = items; this.nextCursor = nextCursor; this.libraryRevision = libraryRevision;
        }
        public List<AssetSummary> items() { return items; }
        public String nextCursor() { return nextCursor; }
        public long libraryRevision() { return libraryRevision; }
    }

    public static final class MediaResource {
        private final String resourceId, role, fileName, mimeType, fileExt, sha256;
        private final long sizeBytes;
        private final Integer width, height;
        private final Long durationMs;
        public MediaResource(String resourceId, String role, String fileName, String mimeType, String fileExt,
                             long sizeBytes, String sha256, Integer width, Integer height, Long durationMs) {
            this.resourceId = resourceId; this.role = role; this.fileName = fileName; this.mimeType = mimeType;
            this.fileExt = fileExt; this.sizeBytes = sizeBytes; this.sha256 = sha256; this.width = width;
            this.height = height; this.durationMs = durationMs;
        }
        public String resourceId() { return resourceId; }
        public String role() { return role; }
        public String fileName() { return fileName; }
        public String mimeType() { return mimeType; }
        public String fileExt() { return fileExt; }
        public long sizeBytes() { return sizeBytes; }
        public String sha256() { return sha256; }
        public Integer width() { return width; }
        public Integer height() { return height; }
        public Long durationMs() { return durationMs; }
    }

    public static final class AssetDetail {
        private final String assetId, type, state;
        private final List<MediaResource> resources;
        private final boolean hasMotion;
        private final String motionStillResourceId, motionResourceId;
        private final Long presentationTimestampUs;
        private final String metadataJson;
        public AssetDetail(String assetId, String type, String state, List<MediaResource> resources, boolean hasMotion,
                           String motionStillResourceId, String motionResourceId, Long presentationTimestampUs, String metadataJson) {
            this.assetId = assetId; this.type = type; this.state = state; this.resources = resources; this.hasMotion = hasMotion;
            this.motionStillResourceId = motionStillResourceId; this.motionResourceId = motionResourceId;
            this.presentationTimestampUs = presentationTimestampUs;
            this.metadataJson = metadataJson;
        }
        public String assetId() { return assetId; }
        public String type() { return type; }
        public String state() { return state; }
        public List<MediaResource> resources() { return resources; }
        public boolean hasMotion() { return hasMotion; }
        public String motionStillResourceId() { return motionStillResourceId; }
        public String motionResourceId() { return motionResourceId; }
        public Long presentationTimestampUs() { return presentationTimestampUs; }
        public String metadataJson() { return metadataJson; }
        public MediaResource originalStill() {
            for (MediaResource resource : resources) if ("source_high_quality".equals(resource.role())) return resource;
            for (MediaResource resource : resources) if ("source_primary".equals(resource.role())) return resource;
            return null;
        }
        public MediaResource motionResource() {
            if (motionResourceId != null) for (MediaResource resource : resources) if (motionResourceId.equals(resource.resourceId())) return resource;
            for (MediaResource resource : resources) if ("source_motion".equals(resource.role())) return resource;
            return null;
        }
    }

    public static final class SuitSearchPart {
        private final String clothingId, name, category;
        public SuitSearchPart(String clothingId, String name, String category) {
            this.clothingId = clothingId; this.name = name; this.category = category;
        }
        public String clothingId() { return clothingId; }
        public String name() { return name; }
        public String category() { return category; }
    }

    public static final class SuitSearchPhoto {
        private final AssetSummary asset;
        private final List<SuitSearchPart> matchedParts;
        public SuitSearchPhoto(AssetSummary asset, List<SuitSearchPart> matchedParts) {
            this.asset = asset; this.matchedParts = matchedParts;
        }
        public AssetSummary asset() { return asset; }
        public List<SuitSearchPart> matchedParts() { return matchedParts; }
    }

    public static final class SuitSearchResult {
        private final String suitId, suitName;
        private final int observedPartCount, photoCount;
        private final Integer totalPartCount;
        private final List<SuitSearchPhoto> photos;
        public SuitSearchResult(String suitId, String suitName, int observedPartCount, Integer totalPartCount,
                                int photoCount, List<SuitSearchPhoto> photos) {
            this.suitId = suitId; this.suitName = suitName; this.observedPartCount = observedPartCount;
            this.totalPartCount = totalPartCount; this.photoCount = photoCount; this.photos = photos;
        }
        public String suitId() { return suitId; }
        public String suitName() { return suitName; }
        public int observedPartCount() { return observedPartCount; }
        public Integer totalPartCount() { return totalPartCount; }
        public int photoCount() { return photoCount; }
        public List<SuitSearchPhoto> photos() { return photos; }
    }

    public static final class SuitSearchResponse {
        private final String query;
        private final List<SuitSearchResult> items;
        public SuitSearchResponse(String query, List<SuitSearchResult> items) {
            this.query = query; this.items = items;
        }
        public String query() { return query; }
        public List<SuitSearchResult> items() { return items; }
    }

    public static final class ClothingSearchPhoto {
        private final AssetSummary asset;
        public ClothingSearchPhoto(AssetSummary asset) { this.asset = asset; }
        public AssetSummary asset() { return asset; }
    }

    public static final class ClothingSearchResult {
        private final String clothingId, name, category, suitId, suitName;
        private final int photoCount;
        private final List<ClothingSearchPhoto> photos;

        public ClothingSearchResult(String clothingId, String name, String category, String suitId, String suitName,
                                    int photoCount, List<ClothingSearchPhoto> photos) {
            this.clothingId = clothingId; this.name = name; this.category = category; this.suitId = suitId;
            this.suitName = suitName; this.photoCount = photoCount; this.photos = photos;
        }

        public String clothingId() { return clothingId; }
        public String name() { return name; }
        public String category() { return category; }
        public String suitId() { return suitId; }
        public String suitName() { return suitName; }
        public int photoCount() { return photoCount; }
        public List<ClothingSearchPhoto> photos() { return photos; }
    }

    public static final class ClothingSearchResponse {
        private final String query;
        private final List<ClothingSearchResult> items;
        public ClothingSearchResponse(String query, List<ClothingSearchResult> items) {
            this.query = query; this.items = items;
        }
        public String query() { return query; }
        public List<ClothingSearchResult> items() { return items; }
    }

    public static final class ProfileSuitStat {
        private final String suitId, suitName;
        private final int photoCount;
        public ProfileSuitStat(String suitId, String suitName, int photoCount) {
            this.suitId = suitId; this.suitName = suitName; this.photoCount = photoCount;
        }
        public String suitId() { return suitId; }
        public String suitName() { return suitName; }
        public int photoCount() { return photoCount; }
    }

    public static final class ProfileClothingStat {
        private final String clothingId, name, category, suitName;
        private final int photoCount;
        public ProfileClothingStat(String clothingId, String name, String category, String suitName, int photoCount) {
            this.clothingId = clothingId; this.name = name; this.category = category; this.suitName = suitName; this.photoCount = photoCount;
        }
        public String clothingId() { return clothingId; }
        public String name() { return name; }
        public String category() { return category; }
        public String suitName() { return suitName; }
        public int photoCount() { return photoCount; }
    }

    public static final class ProfileDictionaryStatus {
        private final String provider, providerVersion, gameVersion, fetchedAt;
        private final int clothingEntries;
        public ProfileDictionaryStatus(String provider, String providerVersion, String gameVersion, String fetchedAt, int clothingEntries) {
            this.provider = provider; this.providerVersion = providerVersion; this.gameVersion = gameVersion;
            this.fetchedAt = fetchedAt; this.clothingEntries = clothingEntries;
        }
        public String provider() { return provider; }
        public String providerVersion() { return providerVersion; }
        public String gameVersion() { return gameVersion; }
        public String fetchedAt() { return fetchedAt; }
        public int clothingEntries() { return clothingEntries; }
    }

    public static final class ProfileStatsResponse {
        private final long libraryRevision;
        private final ProfileDictionaryStatus dictionary;
        private final List<ProfileSuitStat> topSuits;
        private final List<ProfileClothingStat> topClothing;
        public ProfileStatsResponse(long libraryRevision, ProfileDictionaryStatus dictionary,
                                    List<ProfileSuitStat> topSuits, List<ProfileClothingStat> topClothing) {
            this.libraryRevision = libraryRevision; this.dictionary = dictionary;
            this.topSuits = topSuits; this.topClothing = topClothing;
        }
        public long libraryRevision() { return libraryRevision; }
        public ProfileDictionaryStatus dictionary() { return dictionary; }
        public List<ProfileSuitStat> topSuits() { return topSuits; }
        public List<ProfileClothingStat> topClothing() { return topClothing; }
    }

    public static final class Change {
        private final long revision;
        private final String type, assetId, occurredAt;
        public Change(long revision, String type, String assetId, String occurredAt) {
            this.revision = revision; this.type = type; this.assetId = assetId; this.occurredAt = occurredAt;
        }
        public long revision() { return revision; }
        public String type() { return type; }
        public String assetId() { return assetId; }
        public String occurredAt() { return occurredAt; }
    }

    public static final class Changes {
        private final List<Change> items;
        private final long libraryRevision;
        private final boolean fullResyncRequired;
        public Changes(List<Change> items, long libraryRevision, boolean fullResyncRequired) {
            this.items = items; this.libraryRevision = libraryRevision; this.fullResyncRequired = fullResyncRequired;
        }
        public List<Change> items() { return items; }
        public long libraryRevision() { return libraryRevision; }
        public boolean fullResyncRequired() { return fullResyncRequired; }
    }
}
