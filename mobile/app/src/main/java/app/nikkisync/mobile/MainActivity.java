package app.nikkisync.mobile;

import android.Manifest;
import android.app.AlertDialog;
import app.nikkisync.mobile.ui.chrome.ChromePage;
import app.nikkisync.mobile.ui.chrome.PhotoViewerPage;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.util.Size;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.media.HuaweiMovingPhotoSaver;
import app.nikkisync.mobile.media.MotionPhotoSaver;
import app.nikkisync.mobile.media.OppoLivePhotoSaver;
import app.nikkisync.mobile.media.OriginalSaver;
import app.nikkisync.mobile.media.SamsungMotionPhotoSaver;
import app.nikkisync.mobile.media.VivoLivePhotoSaver;
import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetPage;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.Changes;
import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.model.Models.PairingPayload;
import app.nikkisync.mobile.model.Models.ProfileClothingStat;
import app.nikkisync.mobile.model.Models.ProfileStatsResponse;
import app.nikkisync.mobile.model.Models.ProfileSuitStat;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.net.ConnectionState;
import app.nikkisync.mobile.support.SupportDiagnostics;
import app.nikkisync.mobile.support.SupportPanel;
import app.nikkisync.mobile.update.AndroidUpdateJob;
import app.nikkisync.mobile.update.AndroidUpdatePanel;
import app.nikkisync.mobile.net.NsdDiscovery;
import app.nikkisync.mobile.net.RealtimeWebSocket;
import app.nikkisync.mobile.protocol.PairingUri;
import app.nikkisync.mobile.security.DeviceIdentity;
import app.nikkisync.mobile.storage.EditedMediaAccess;
import app.nikkisync.mobile.storage.EditedVariantStore;
import app.nikkisync.mobile.storage.SavedPhotoCollection;
import app.nikkisync.mobile.storage.SavedPhotoHealthStore;
import app.nikkisync.mobile.storage.SavedPhotoGroups;
import app.nikkisync.mobile.storage.SavedMetadataSnapshotStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import app.nikkisync.mobile.storage.SavedPhotoRecovery;
import app.nikkisync.mobile.storage.SavedPhotoVerifier;
import app.nikkisync.mobile.storage.RecentPhotoBatchStore;
import app.nikkisync.mobile.storage.SavedViewState;
import app.nikkisync.mobile.storage.ServerStore;
import app.nikkisync.mobile.share.ShareCardExportCoordinator;
import app.nikkisync.mobile.share.ShareCardPreparation;
import app.nikkisync.mobile.share.ShareCardPreviewDialog;
import app.nikkisync.mobile.media.live.LivePhotoControls;
import app.nikkisync.mobile.media.live.LivePhotoExporter;
import app.nikkisync.mobile.media.live.LivePhotoProfile;
import app.nikkisync.mobile.inspiration.InspirationPage;
import app.nikkisync.mobile.ui.ClothingSearchGrid;
import app.nikkisync.mobile.ui.GalleryAdapter;
import app.nikkisync.mobile.ui.SavedPhotoAdapter;
import app.nikkisync.mobile.ui.SavedFilterSheet;
import app.nikkisync.mobile.ui.SavedMetadataText;
import app.nikkisync.mobile.ui.PlayerFacingDetails;
import app.nikkisync.mobile.ui.AdviceDialog;
import app.nikkisync.mobile.ui.TroubleshootingAdvice;
import app.nikkisync.mobile.ui.SuitSearchDialog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
public final class MainActivity extends ComponentActivity implements NsdDiscovery.Listener, ChromePage.Owner {
    private ChromeNavigationHost navigation;
    @Override public ChromeNavigationHost navigationHost(){return navigation;}
    @Override protected void onStop(){
        if(galleryDragSelection!=null)galleryDragSelection.finish();
        if(imageLoader!=null)imageLoader.pauseOfflineCaching();
        cacheWakeRequested=false;getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        connectionForeground=false;main.removeCallbacks(connectionRecovery);
        inspirationEpoch.incrementAndGet();
        connectionState.beginSession();realtimeStop();if(discovery!=null)discovery.stop();
        refreshViewerConnections();
        if(navigation!=null)navigation.interrupt();if(homeTabs!=null)homeTabs.interrupt();super.onStop();
    }
    @Override protected void onResume(){
        super.onResume();connectionForeground=true;
        if(identity==null)return;
        if(!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()){
            connectionState.beginSession();realtimeStop();if(discovery!=null)discovery.stop();finish();return;
        }
        if(activeTab==TAB_SAVED)refreshSavedPhotos(true);
        resumeConnection();
    }
    private static final int NEARBY_PERMISSION = 401;
    private static final int PAIR_QR_SCAN = 402;
    private static final int UPDATE_NOTIFICATION_PERMISSION = 403;
    private static final int TAB_GALLERY = 0;
    private static final int TAB_SAVED = 1;
    private static final int TAB_MY = 2;
    private static final String PROJECT_URL = "https://github.com/ToStardust/NikkiSync";
    private static final String UPDATES_URL = "https://github.com/QianQianLuLu1/MeowStarMap/releases";
    private static final String NIKKI_GALLERY_URL = "https://github.com/QianQianLuLu1/NikkiGallery";
    private static final String NIKKI_ALBUMS_URL = "https://github.com/RanAxro/nikki_albums";
    private static final String MEOW_STAR_MAP_URL = "https://github.com/QianQianLuLu1/MeowStarMap";
    private static final String NUAN5_URL = "https://nuan5.pro/";
    private static final String GONGEO_URL = "https://gongeo.us/";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService publicNetworkIo = Executors.newFixedThreadPool(2);
    private final ExecutorService savedHealthIo = Executors.newSingleThreadExecutor();
    private final ExecutorService savedSourceCheckIo = Executors.newSingleThreadExecutor();
    // Local organizer reads must never queue behind network timeouts.
    private final ExecutorService organizerIo = Executors.newSingleThreadExecutor();
    private final ExecutorService organizerNetworkIo = Executors.newSingleThreadExecutor();
    private final ExecutorService inspirationIo = Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicLong inspirationEpoch=new java.util.concurrent.atomic.AtomicLong();
    private InspirationPage inspirationPage;
    private boolean inspirationRunning,inspirationAgain;
    private long lastInspirationAttempt;
    private String inspirationMessage="灵感保存在手机本地，连接电脑后可同步。";
    private final ExecutorService shareWorker = new java.util.concurrent.ThreadPoolExecutor(0,1,15,
            java.util.concurrent.TimeUnit.SECONDS,new java.util.concurrent.LinkedBlockingQueue<>());
    private app.nikkisync.mobile.ui.OperationProgressDialog shareProgress,photoSaveProgress;
    private final AtomicBoolean syncing = new AtomicBoolean(false);
    private ImageLoader imageLoader;
    private ShareCardExportCoordinator shareCardExportCoordinator;
    private ShareCardPreviewDialog shareCardPreview;
    private Button pendingShareCardButton;
    private final OriginalSaver originalSaver = new OriginalSaver();
    private final MotionPhotoSaver motionPhotoSaver = new MotionPhotoSaver();
    private final OppoLivePhotoSaver oppoLivePhotoSaver = new OppoLivePhotoSaver();
    private final SamsungMotionPhotoSaver samsungMotionPhotoSaver = new SamsungMotionPhotoSaver();
    private final VivoLivePhotoSaver vivoLivePhotoSaver = new VivoLivePhotoSaver();
    private final HuaweiMovingPhotoSaver huaweiMovingPhotoSaver = new HuaweiMovingPhotoSaver();
    private final Map<String, Integer> rotationByAssetId = new LinkedHashMap<>();

    private ServerStore serverStore;
    private app.nikkisync.mobile.storage.OrganizerStore organizer;
    private RecentPhotoBatchStore recentPhotoBatchStore;
    private Set<String> recentPhotoIds = Set.of();
    private app.nikkisync.mobile.ui.OrganizerPage organizerPage;
    private Button recentDeletedButton;
    private boolean organizerSyncing;
    private boolean organizerSyncAgain,organizerWorkPending;
    private String organizerSyncFailure;
    private SavedPhotoStore savedPhotoStore;
    private SavedPhotoHealthStore savedPhotoHealthStore;
    private EditedVariantStore editedVariantStore;
    private SavedMetadataSnapshotStore savedMetadataSnapshotStore;
    private app.nikkisync.mobile.storage.SavedSourceStore savedSourceStore;
    private String galleryUid,galleryFolder,galleryVersion,savedUid,savedFolder;
    private int galleryType,gallerySort;
    private Button galleryFilterButton;
    private DeviceIdentity identity;
    private NsdDiscovery discovery;
    private NikkiSyncClient client;
    private final ConnectionState connectionState = new ConnectionState();
    private boolean connectionProbePending;
    private RealtimeWebSocket realtime;
    private PairedServer pairedServer;
    private boolean connectionForeground;
    private boolean libraryLoadedForSession;
    private boolean libraryLoading;
    private boolean cacheWakeRequested;
    private app.nikkisync.mobile.net.ConnectionFailure connectionFailure;
    private long connectionAdviceShownForSession = -1;
    private final Runnable connectionRecovery=new Runnable(){
        @Override public void run(){
            if(!connectionForeground||isFinishing()||isDestroyed()||identity==null
                    ||!new app.nikkisync.mobile.privacy.PrivacyConsentStore(MainActivity.this).accepted())return;
            if(pairedServer!=null){
                if(!connectionState.isReachable()){
                    if(discovery!=null)discovery.restart();
                    probeConnection(connectionState.session());
                }else {
                    if(!libraryLoadedForSession)loadLibrary("已重新连接 · 正在读取图库…");
                    else {maybeWarmOfflineCache();syncChanges();}
                    syncOrganizer();
                    syncInspirations(false);
                }
            }
            main.postDelayed(this,organizerWorkPending?5_000:15_000);
        }
    };

    private void resumeConnection(){
        if(discovery!=null&&canDiscoverNearby())discovery.start();
        PairedServer saved=serverStore==null?null:serverStore.load();
        if(saved!=null)connect(saved,"正在连接已配对电脑…");
        main.removeCallbacks(connectionRecovery);main.postDelayed(connectionRecovery,15_000);
    }
    private ProfileStatsResponse profileStats;
    private boolean profileStatsLoading;
    private SavedPhotoStore.Record pendingEditedLinkSource;
    private final ActivityResultLauncher<PickVisualMediaRequest> editedPhotoPicker =
            registerForActivityResult(new ActivityResultContracts.PickMultipleVisualMedia(), this::handleEditedPhotoSelection);
    private final ActivityResultLauncher<String> diagnosticExport =
            registerForActivityResult(new ActivityResultContracts.CreateDocument("application/json"),this::writeDiagnosticExport);

    private TextView titleLabel;
    private TextView status;
    private TextView countLabel;
    private TextView selectionLabel;
    private TextView tabPlaceholder;
    private TextView galleryEmpty;
    private TextView savedEmpty;
    private TextView savedSummary;
    private LinearLayout myContent;
    private LinearLayout settingsContent, profileStatsContent, aboutContent;
    private AndroidUpdatePanel appUpdatePanel;
    private app.nikkisync.mobile.ui.chrome.ChromeHost supportPage, troubleshootingPage;
    private LinearLayout troubleshootingContent;
    private LinearLayout cacheSettingsContent;
    private app.nikkisync.mobile.ui.chrome.ChromeHost cacheSettingsPage;
    private TextView offlineCacheStatus;
    private app.nikkisync.mobile.ui.chrome.ChromeHost settingsPage, profileStatsPage, aboutPage;
    private app.nikkisync.mobile.storage.StylistProfileStore stylistProfiles;
    private Button settingsButton;
    private Button pairButton;
    private Button searchButton;
    private Button saveButton;
    private app.nikkisync.mobile.ui.chrome.PhotoLayoutDock navigationDock;
    private Button savedFilterButton;
    private ProgressBar progress;
    private GalleryAdapter adapter;
    private SavedPhotoAdapter savedAdapter;
    private LinearLayout galleryMeta;
    private LinearLayout gallerySearchActions;
    private LinearLayout savedControls;
    private LinearLayout selectionBar;
    private RecyclerView galleryList;
    private app.nikkisync.mobile.ui.GalleryDragSelection galleryDragSelection;
    private RecyclerView savedList;
    private ScrollView myScroll;
    private int activeTab = TAB_GALLERY;
    private app.nikkisync.mobile.ui.chrome.HomeTabPager homeTabs;
    private int savedFilter = SavedViewState.FILTER_ALL;
    private int savedSort = SavedViewState.SORT_SAVED;
    private final List<AssetSummary> assets = new ArrayList<>();
    private final Map<String, SavedPhotoHealthStore.Entry> savedHealth = new LinkedHashMap<>();
    private final Map<PhotoViewerPage,Runnable> viewerConnections = new LinkedHashMap<>();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if(!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()) {
            navigation=new ChromeNavigationHost(this);navigation.bind(this);
            app.nikkisync.mobile.privacy.PrivacyUi.showConsent(this,navigation,()->{
                navigation.close();navigation=null;initializeAfterConsent();
            });
            return;
        }
        initializeAfterConsent();
    }

    private void initializeAfterConsent() {
        if(isFinishing()||isDestroyed()||!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted())return;
        imageLoader = new ImageLoader(this);
        shareCardExportCoordinator = new ShareCardExportCoordinator(
                this,
                shareWorker,
                command -> main.post(command)
        );
        serverStore = new ServerStore(this);
        organizer = new app.nikkisync.mobile.storage.OrganizerStore(this);
        recentPhotoBatchStore = new RecentPhotoBatchStore(this);
        savedPhotoStore = new SavedPhotoStore(this);
        savedPhotoHealthStore = new SavedPhotoHealthStore(this);
        editedVariantStore = new EditedVariantStore(this);
        savedMetadataSnapshotStore = new SavedMetadataSnapshotStore(this);
        savedSourceStore=new app.nikkisync.mobile.storage.SavedSourceStore(this);
        try { identity = DeviceIdentity.getOrCreate(this); }
        catch (Exception error) {
            new AlertDialog.Builder(this).setTitle("设备身份初始化失败").setMessage(error.toString()).setPositiveButton("退出", (d, w) -> finish()).show();
            return;
        }
        buildUi();
        discovery = new NsdDiscovery(this, this);
        pairedServer = serverStore.load();
        if (pairedServer != null) recentPhotoIds = recentPhotoBatchStore.load(app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer));
        updatePairButton();
        requestNearbyAndDiscover();
        handleIntent(getIntent());
        if (pairedServer != null) setStatus("正在连接已配对电脑…");
        else if (identity.wasRecovered()) setStatus("安全密钥已重建 · 请重新配对电脑");
        else setStatus("尚未配对 · 点击右上角配对电脑");
        updateGalleryEmptyState();
        if(connectionForeground)resumeConnection();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);setIntent(intent);
        if(new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()&&identity!=null)handleIntent(intent);
    }

    @Override protected void onDestroy() {
        if (shareCardExportCoordinator != null) shareCardExportCoordinator.cancel();
        if (shareCardPreview != null) shareCardPreview.dismiss();
        connectionState.beginSession();
        main.removeCallbacks(connectionRecovery);
        if(shareProgress!=null)shareProgress.dismiss();
        if(photoSaveProgress!=null)photoSaveProgress.dismiss();
        shareWorker.shutdownNow();
        if(navigation!=null)navigation.close();
        viewerConnections.clear();
        realtimeStop();
        if (discovery != null) discovery.stop();
        if (imageLoader != null) imageLoader.shutdown();
        if (savedAdapter != null) savedAdapter.shutdown();
        io.shutdownNow();
        publicNetworkIo.shutdownNow();
        organizerIo.shutdownNow();
        savedHealthIo.shutdownNow();savedSourceCheckIo.shutdownNow();
        organizerNetworkIo.shutdownNow();
        inspirationEpoch.incrementAndGet();inspirationIo.shutdownNow();
        if (editedVariantStore != null) editedVariantStore.close();
        if (savedMetadataSnapshotStore != null) savedMetadataSnapshotStore.close();
        if(savedSourceStore!=null)savedSourceStore.close();
        super.onDestroy();
    }

    private void buildUi() {
        app.nikkisync.mobile.ui.chrome.ChromeHost chrome = new app.nikkisync.mobile.ui.chrome.ChromeHost(this);
        chrome.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarContrastEnforced(false);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(0, dp(8), 0, 0);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), dp(12), dp(10), dp(12));
        header.setBackgroundColor(Color.TRANSPARENT);

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        titleLabel = text("暖暖相册", 25, true, getColor(R.color.text_primary));
        status = text("准备中…", 12, false, getColor(R.color.text_secondary));
        titleBox.addView(titleLabel);
        titleBox.addView(status);
        header.addView(titleBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        pairButton = button("配对");
        pairButton.setOnClickListener(v -> startPairScanner());
        header.addView(pairButton);
        settingsButton = button("设置");
        settingsButton.setContentDescription("设置");
        settingsButton.setVisibility(View.GONE);
        settingsButton.setOnClickListener(v -> showSettings());
        header.addView(settingsButton);
        root.addView(header);

        searchButton = button("搜索套装或散件");
        searchButton.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        searchButton.setTextColor(getColor(R.color.text_secondary));
        searchButton.setBackgroundResource(R.drawable.bg_glass_card);
        searchButton.setMinHeight(dp(48));
        searchButton.setMinimumHeight(dp(48));
        searchButton.setOnClickListener(v -> {
            NikkiSyncClient current = client;
            if (current == null) {
                toast("请先连接电脑");
                return;
            }
            SuitSearchDialog.showWithContext(this, current, imageLoader, io, main, this::showViewer);
        });
        gallerySearchActions=new LinearLayout(this);gallerySearchActions.setGravity(Gravity.CENTER_VERTICAL);
        gallerySearchActions.addView(searchButton,new LinearLayout.LayoutParams(0,dp(48),1));
        galleryFilterButton=button("筛选");galleryFilterButton.setBackgroundResource(R.drawable.bg_glass_card);
        galleryFilterButton.setOnClickListener(v->showGalleryFilterSheet());
        LinearLayout.LayoutParams filterLp=new LinearLayout.LayoutParams(dp(76),dp(48));filterLp.leftMargin=dp(8);gallerySearchActions.addView(galleryFilterButton,filterLp);
        LinearLayout.LayoutParams searchLp=new LinearLayout.LayoutParams(-1,-2);searchLp.topMargin=dp(10);root.addView(gallerySearchActions,searchLp);

        galleryMeta = new LinearLayout(this);
        galleryMeta.setGravity(Gravity.CENTER_VERTICAL);
        galleryMeta.setPadding(dp(4), dp(10), dp(4), dp(8));
        countLabel = text("已同步 0 张 · 已缓存 0 张", 12, true, getColor(R.color.text_primary));
        galleryMeta.addView(countLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button refresh = button("刷新");
        refresh.setOnClickListener(v -> loadLibrary("正在刷新图库…",true));
        galleryMeta.addView(refresh);
        root.addView(galleryMeta);

        savedControls = new LinearLayout(this);
        savedControls.setGravity(Gravity.CENTER_VERTICAL);
        savedControls.setPadding(dp(4), dp(4), dp(4), dp(4));
        savedControls.setVisibility(View.GONE);

        savedSummary = text("0 张", 12, false, getColor(R.color.text_secondary));
        savedSummary.setSingleLine(true);
        savedSummary.setEllipsize(android.text.TextUtils.TruncateAt.END);
        savedControls.addView(savedSummary,new LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1));

        savedFilterButton = button(SavedFilterSheet.triggerLabel(savedFilter,savedSort));
        savedFilterButton.setOnClickListener(v -> showSavedFilterSheet());
        savedControls.addView(savedFilterButton);
        recentDeletedButton=button("最近删除");recentDeletedButton.setBackground(roundRect(0xE8FFFFFF,24));recentDeletedButton.setEnabled(false);
        recentDeletedButton.setOnClickListener(v->{if(organizer!=null&&pairedServer!=null&&(organizerPage==null||!organizerPage.isOpen())){organizerPage=new app.nikkisync.mobile.ui.OrganizerPage(this,organizer,pairedServer,client,imageLoader,organizerIo,main,()->{refreshOrganizer();syncOrganizer();});organizerPage.setSyncFailure(organizerSyncFailure);}});
        LinearLayout.LayoutParams recentDeletedLayout=new LinearLayout.LayoutParams(-2,-2);recentDeletedLayout.leftMargin=dp(8);savedControls.addView(recentDeletedButton,recentDeletedLayout);
        root.addView(savedControls);

        var content = new app.nikkisync.mobile.ui.chrome.HomeTabPager(this,this::switchTab,this::prepareTab);
        homeTabs=content;
        FrameLayout galleryPage=new FrameLayout(this),savedPage=new FrameLayout(this),myPage=new FrameLayout(this);
        content.addPage(galleryPage);content.addPage(savedPage);content.addPage(myPage);
        galleryList = new RecyclerView(this);
        galleryList.setVerticalScrollBarEnabled(false); galleryList.setClipToPadding(false); galleryList.setPadding(0, 0, 0, dp(12));
        GridLayoutManager layout = new GridLayoutManager(this, 3);
        galleryList.setLayoutManager(layout);
        adapter = new GalleryAdapter(this, imageLoader, () -> client, new GalleryAdapter.Listener() {
            @Override public void onPhotoClick(AssetSummary asset) {
                showViewer(asset);
            }

            @Override public boolean onPhotoLongClick(AssetSummary asset) {
                adapter.toggle(asset); updateSelection(); return true;
            }
            @Override public void onSelectionChanged() { updateSelection(); }
        });
        layout.setSpanSizeLookup(new GridLayoutManager.SpanSizeLookup() {
            @Override public int getSpanSize(int position) { return adapter.isHeader(position) ? 3 : 1; }
        });
        galleryList.setAdapter(adapter);
        adapter.enableGroupSelection();
        galleryDragSelection = new app.nikkisync.mobile.ui.GalleryDragSelection(galleryList, adapter);
        galleryList.addOnItemTouchListener(galleryDragSelection);
        galleryPage.addView(galleryList, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        savedList = new RecyclerView(this);
        savedList.setVerticalScrollBarEnabled(false);
        savedList.setClipToPadding(false);
        savedList.setPadding(0, 0, 0, dp(12));
        GridLayoutManager savedLayout = new GridLayoutManager(this, 3);
        savedList.setLayoutManager(savedLayout);
        savedAdapter = new SavedPhotoAdapter(this, new SavedPhotoAdapter.Listener() {
            @Override public void onOriginalClick(SavedPhotoStore.Record record) {
                showSavedPhotoDetails(record);
            }

            @Override public void onEditedClick(EditedVariantStore.Variant variant) {
                showEditedPhotoDetails(variant);
            }
            @Override public void onRemoveOriginal(SavedPhotoStore.Record record) {
                confirmRemoveSavedRecord(record);
            }
            @Override public void onRemoveEdited(EditedVariantStore.Variant variant) {
                confirmRemoveEditedRecord(variant);
            }
            @Override public void loadOriginalFallback(SavedPhotoStore.Record record, ImageView target) {
                AssetSummary source=savedSource(record.assetId());
                if(source!=null&&pairedServer!=null){
                    if(findAsset(record.assetId())!=null&&connectionState.isReachable()&&client!=null)imageLoader.load(client,source,target);
                    else imageLoader.loadOffline(pairedServer,source,target);
                }
            }
        });
        savedLayout.setSpanSizeLookup(new GridLayoutManager.SpanSizeLookup() {
            @Override public int getSpanSize(int position) { return savedAdapter.isHeader(position) ? 3 : 1; }
        });
        savedList.setAdapter(savedAdapter);
        savedPage.addView(savedList, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        myScroll = new ScrollView(this);
        myScroll.setFillViewport(true);
        myContent = new LinearLayout(this);
        myContent.setOrientation(LinearLayout.VERTICAL);
        myContent.setPadding(0, dp(8), 0, dp(24));
        myScroll.addView(myContent, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        myPage.addView(myScroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        galleryEmpty = text("", 14, false, getColor(R.color.text_secondary));
        galleryEmpty.setGravity(Gravity.CENTER); galleryEmpty.setPadding(dp(28), dp(28), dp(28), dp(28)); galleryEmpty.setVisibility(View.GONE);
        galleryPage.addView(galleryEmpty, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        savedEmpty = text("还没有保存记录。\n从图库选择照片并保存原图后，会出现在这里。", 14, false, getColor(R.color.text_secondary));
        savedEmpty.setGravity(Gravity.CENTER);
        savedEmpty.setPadding(dp(28), dp(28), dp(28), dp(28));
        savedEmpty.setVisibility(View.GONE);
        savedPage.addView(savedEmpty, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        tabPlaceholder = text("", 14, false, getColor(R.color.text_secondary));
        tabPlaceholder.setGravity(Gravity.CENTER); tabPlaceholder.setVisibility(View.GONE); tabPlaceholder.setPadding(dp(28), dp(28), dp(28), dp(28));
        content.addView(tabPlaceholder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this); progress.setVisibility(View.GONE);
        FrameLayout.LayoutParams progressLp = new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.CENTER); content.addView(progress, progressLp);
        chrome.contentLayer().addView(content, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout bottomChrome = new LinearLayout(this);
        bottomChrome.setOrientation(LinearLayout.VERTICAL);

        selectionBar = new LinearLayout(this); selectionBar.setGravity(Gravity.CENTER_VERTICAL); selectionBar.setPadding(dp(12), dp(8), dp(8), dp(8));
        selectionBar.setBackgroundResource(R.drawable.bg_glass_card);
        selectionLabel = text("", 13, true, getColor(R.color.text_primary));
        selectionBar.addView(selectionLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        saveButton = button("保存原图"); saveButton.setOnClickListener(v -> saveSelected()); selectionBar.addView(saveButton);
        Button deleteSelected=button("待删除");deleteSelected.setOnClickListener(v->queueDeletion(adapter.selectedItems()));selectionBar.addView(deleteSelected);
        selectionBar.setTag("selectionBar"); selectionBar.setVisibility(View.GONE);
        bottomChrome.addView(selectionBar);

        navigationDock = new app.nikkisync.mobile.ui.chrome.PhotoLayoutDock(this,this::switchTab);
        View bottomNav = navigationDock;
        bottomNav.setOutlineProvider(new android.view.ViewOutlineProvider(){
            @Override public void getOutline(View view,android.graphics.Outline outline){
                outline.setRoundRect(0,0,view.getWidth(),view.getHeight(),dp(28));
            }
        });
        bottomChrome.addView(bottomNav, new LinearLayout.LayoutParams(-1, dp(68)));

        myScroll.setClipToPadding(false);
        chrome.installChrome(root, bottomChrome, galleryList, savedList, myScroll);
        chrome.addDockEffect(bottomNav);
        RecyclerView.OnScrollListener chromeScroll = new RecyclerView.OnScrollListener() {
            @Override public void onScrollStateChanged(RecyclerView view, int state) {
                chrome.setScrolling(state != RecyclerView.SCROLL_STATE_IDLE);
            }
        };
        galleryList.addOnScrollListener(chromeScroll);
        savedList.addOnScrollListener(chromeScroll);
        navigation=new ChromeNavigationHost(this);
        navigation.setRoot(chrome);navigation.bind(this);
        setContentView(navigation);
        switchTab(TAB_GALLERY);
    }

    private void switchTab(int tab) {
        if(tab<TAB_GALLERY||tab>TAB_MY)return;
        activeTab = tab;
        boolean gallery = tab == TAB_GALLERY;
        boolean saved = tab == TAB_SAVED;
        boolean my = tab == TAB_MY;

        galleryMeta.setVisibility(gallery ? View.VISIBLE : View.GONE);
        updateSavedControlsVisibility(saved);
        gallerySearchActions.setVisibility(gallery ? View.VISIBLE : View.GONE);
        tabPlaceholder.setVisibility(View.GONE);
        pairButton.setVisibility(gallery ? View.VISIBLE : View.GONE);
        settingsButton.setVisibility(my ? View.VISIBLE : View.GONE);

        if (gallery) {
            titleLabel.setText("暖暖相册");
            tabPlaceholder.setText("");
        } else if (saved) {
            titleLabel.setText("已保存");
            refreshSavedPhotos();
        } else {
            titleLabel.setText("我的");
            refreshMyPage();
        }

        navigationDock.select(tab);
        homeTabs.select(tab);
        updateSelection();
        updateGalleryEmptyState();
        updateSavedEmptyState();
    }

    private void prepareTab(int tab){
        if(tab==TAB_MY)refreshMyPage();
        else if(tab==TAB_SAVED)refreshSavedPhotos();
    }

    private void showSavedFilterSheet() {
        SavedFilterSheet panel=new SavedFilterSheet(this,savedFilter,savedSort);
        panel.withSources(savedSources(),savedUid,savedFolder,false);
        panel.setListener(new SavedFilterSheet.Listener() {
            @Override public void onApply(int filter,int sort) {
                savedFilter=filter;
                savedSort=sort;
                savedUid=panel.selectedUid();savedFolder=panel.selectedFolder();
                savedFilterButton.setText(savedUid!=null||savedFolder!=null?"筛选 · 已启用":SavedFilterSheet.triggerLabel(filter,sort));
                refreshSavedPhotos();
                panel.dismiss();
            }
            @Override public void onRecoverHistoricalSavedPhotos() {
                panel.dismiss();
                recoverHistoricalSavedPhotos();
            }
            @Override public void onCancel() {panel.dismiss();}
        });
        panel.show(this);
    }

    private void updateSavedControlsVisibility(boolean show) {
        savedControls.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private List<AssetSummary> savedSources(){
        Map<String,AssetSummary> sources=savedSourceStore==null?new LinkedHashMap<>():new LinkedHashMap<>(savedSourceStore.all());
        for(AssetSummary asset:assets)sources.put(asset.assetId(),asset);
        return new ArrayList<>(sources.values());
    }
    private void showGalleryFilterSheet(){
        SavedFilterSheet panel=new SavedFilterSheet(this,galleryType,gallerySort)
                .withVersions(assets,galleryVersion).withSources(assets,galleryUid,galleryFolder,true);
        panel.setListener(new SavedFilterSheet.Listener(){
            public void onApply(int type,int sort){
                galleryType=type;gallerySort=sort;galleryUid=panel.selectedUid();galleryFolder=panel.selectedFolder();
                galleryVersion=panel.selectedVersion();renderGallery();panel.dismiss();
            }
            public void onCancel(){panel.dismiss();}public void onRecoverHistoricalSavedPhotos(){}
        });panel.show(this);
    }
    private List<AssetSummary> filteredGallery(){
        List<AssetSummary> out=new ArrayList<>();
        for(AssetSummary asset:assets)if(app.nikkisync.mobile.ui.PhotoScopeFilter.matches(asset,galleryType,galleryUid,galleryFolder)
                &&(galleryVersion==null||galleryVersion.equals(app.nikkisync.mobile.ui.GalleryVersionGroups.filterKey(asset.gameVersion()))))out.add(asset);
        out.sort(java.util.Comparator.comparing((AssetSummary a)->a.capturedAt()==null?"":a.capturedAt()).thenComparing(AssetSummary::assetId));
        if(gallerySort==0)java.util.Collections.reverse(out);return out;
    }
    private void renderGallery(){if(adapter!=null)adapter.setItems(filteredGallery(),recentPhotoIds);if(galleryFilterButton!=null){boolean active=galleryType!=0||gallerySort!=0||galleryUid!=null||galleryFolder!=null||galleryVersion!=null;galleryFilterButton.setText(active?"筛选 •":"筛选");galleryFilterButton.setContentDescription(active?"筛选，已启用筛选或排序":"筛选照片");}if(organizer!=null&&pairedServer!=null)refreshOrganizer();updateGalleryEmptyState();}
    private void updateGalleryCacheCount(){
        if(countLabel==null)return;var progress=imageLoader==null?null:imageLoader.offlineProgress();
        int photos=(int)assets.stream().filter(asset->!asset.isVideo()).count();
        int count=progress!=null&&progress.total()==photos?Math.min(progress.cached(),photos):0;
        countLabel.setText(photos==assets.size()?"已同步 "+photos+" 张 · 已缓存 "+count+" 张":"已同步 "+assets.size()+" 项 · 已缓存 "+count+" 张照片");
    }

    private void refreshMyPage() {
        if (myContent == null) return;
        myContent.removeAllViews();
        Map<String, Integer> uidCounts = new LinkedHashMap<>();
        int liveCount = 0;

        for (AssetSummary asset : assets) {
            if (asset.hasMotion()) liveCount++;

            if (asset.uid() != null && !asset.uid().isBlank()) {
                uidCounts.put(asset.uid(), uidCounts.getOrDefault(asset.uid(), 0) + 1);
            }
        }

        addStylistCard(uidCounts);

        List<SavedPhotoStore.Record> savedRecords = savedPhotoStore == null ? List.of() : savedPhotoStore.load();
        Map<String, SavedPhotoHealthStore.Entry> health = savedPhotoHealthStore == null
                ? Map.of()
                : savedPhotoHealthStore.load();
        int missingSaved = 0;
        for (SavedPhotoStore.Record record : savedRecords) {
            SavedPhotoHealthStore.Entry entry = health.get(record.uri());
            if (entry != null && entry.isMissing()) missingSaved++;
        }

        String stats = "照片：" + assets.size() + " 张"
                + "\nLIVE：" + liveCount + " 张"
                + "\n已保存：" + savedRecords.size() + " 张"
                + (missingSaved == 0 ? "" : "\n需重新保存：" + missingSaved + " 张");
        addMyActionCard("图库概况", stats, "查看常用穿搭", this::showProfileStats);
        addMyActionCard("穿搭灵感库", "收藏搭配码、染色码与参考图，随时查找和复制。",
                "打开灵感库", () -> {
                    if(inspirationPage!=null)return;
                    inspirationPage=InspirationPage.show(this,()->inspirationPage=null,()->syncInspirations(true));
                    inspirationPage.setSyncStatus(inspirationMessage);syncInspirations(true);
                });
    }

    private app.nikkisync.mobile.storage.StylistProfileStore stylistProfiles() {
        if(stylistProfiles==null)stylistProfiles=new app.nikkisync.mobile.storage.StylistProfileStore(this);
        return stylistProfiles;
    }

    private void addStylistCard(Map<String,Integer> uids) {
        LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14),dp(13),dp(14),dp(13));card.setBackgroundResource(R.drawable.bg_glass_card);
        card.addView(text("搭配师 UID",16,true,getColor(R.color.text_primary)));
        List<String> identities=uids.isEmpty()?List.of(""):new ArrayList<>(uids.keySet());
        for(String uid:identities) {
            String nickname=stylistProfiles().nickname(uid);
            TextView name=text((nickname.isEmpty()?"昵称未填写":nickname)+(uid.equals(stylistProfiles().defaultUid())&&!uid.isEmpty()?" · 默认":""),21,true,getColor(R.color.text_primary));
            name.setPadding(0,dp(14),0,dp(6));card.addView(name);
            card.addView(text(uid.isEmpty()?"同步照片后自动读取 UID":"UID  "+uid,14,false,getColor(R.color.text_secondary)));
            LinearLayout actions=new LinearLayout(this);actions.setGravity(Gravity.CENTER_VERTICAL);
            actions.setClipChildren(false);actions.setClipToPadding(false);actions.setPadding(0,0,0,dp(10));
            Button copy=button("复制 UID");copy.setEnabled(!uid.isEmpty());copy.setOnClickListener(v->copyText("Nikki UID",uid));
            Button edit=button(nickname.isEmpty()?"填写昵称":"修改昵称");edit.setOnClickListener(v->editStylistNickname(uid));
            copy.setMinHeight(dp(48));edit.setMinHeight(dp(48));
            LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,-2,1);lp.topMargin=dp(10);lp.rightMargin=dp(8);
            actions.addView(copy,lp);LinearLayout.LayoutParams editLp=new LinearLayout.LayoutParams(0,-2,1);editLp.topMargin=dp(10);
            actions.addView(edit,editLp);card.addView(actions);
        }
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(10);myContent.addView(card,lp);
    }

    private void editStylistNickname(String uid) {
        android.widget.EditText input=new android.widget.EditText(this);
        input.setSingleLine(true);input.setHint("填写你的搭配师昵称");input.setText(stylistProfiles().nickname(uid));
        input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(64)});
        input.setPadding(dp(20),dp(14),dp(20),dp(14));
        LinearLayout form=new LinearLayout(this);form.setOrientation(LinearLayout.VERTICAL);
        form.addView(text("昵称保存在这台手机上；留空可恢复自动读取。默认昵称用于分享图和相机水印。",14,false,getColor(R.color.text_secondary)));
        form.addView(input,new LinearLayout.LayoutParams(-1,-2));
        LinearLayout actions=new LinearLayout(this);actions.setOrientation(LinearLayout.VERTICAL);
        var sheet=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(this,text("搭配师昵称",21,true,getColor(R.color.text_primary)),form,actions).wrapContentForm();
        addSheetAction(actions,"取消",()->navigation.dismiss(sheet));
        addSheetAction(actions,"保存",()->{stylistProfiles().setManualNickname(uid,input.getText().toString());navigation.dismiss(sheet);refreshMyPage();refreshSettingsPage();});
        addSheetAction(actions,"保存并设置为默认",()->{
            if(uid.isEmpty()||input.getText().toString().isBlank()){toast("请先同步 UID 并填写昵称");return;}
            stylistProfiles().setManualNickname(uid,input.getText().toString());stylistProfiles().setDefaultUid(uid);navigation.dismiss(sheet);refreshMyPage();refreshSettingsPage();
        });
        navigation.showSheet(sheet);
    }

    private void addSheetAction(LinearLayout actions,String label,Runnable action){
        Button control=button(label);control.setMinHeight(dp(48));control.setOnClickListener(v->action.run());
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(6);actions.addView(control,lp);
    }
    private app.nikkisync.mobile.storage.ExportWatermarkStore watermarks(){return new app.nikkisync.mobile.storage.ExportWatermarkStore(this);}
    private void editWatermark(){
        var settings=watermarks();LinearLayout form=new LinearLayout(this);form.setOrientation(LinearLayout.VERTICAL);
        form.addView(text("留空使用默认昵称与 UID；清空后保存即可恢复默认。",14,false,getColor(R.color.text_secondary)));
        android.widget.EditText first=new android.widget.EditText(this);first.setSingleLine(true);first.setText(settings.shareTitle());
        first.setHint("顶部文字，留空使用默认昵称");
        first.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(96)});form.addView(first,new LinearLayout.LayoutParams(-1,-2));
        android.widget.EditText second=new android.widget.EditText(this);second.setSingleLine(true);second.setText(settings.shareFooter());second.setHint("底部文字（默认：UID 与 MomoCamera）");
        second.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(128)});form.addView(second,new LinearLayout.LayoutParams(-1,-2));
        LinearLayout actions=new LinearLayout(this);actions.setOrientation(LinearLayout.VERTICAL);
        var sheet=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(this,text("分享图水印",21,true,getColor(R.color.text_primary)),form,actions).wrapContentForm();
        addSheetAction(actions,"取消",()->navigation.dismiss(sheet));
        addSheetAction(actions,"保存",()->{try{settings.setShareText(first.getText().toString(),second.getText().toString());navigation.dismiss(sheet);refreshSettingsPage();}catch(IllegalArgumentException error){toast(error.getMessage());}});
        addSheetAction(actions,"恢复默认",()->{settings.setShareText("","");navigation.dismiss(sheet);refreshSettingsPage();});
        navigation.showSheet(sheet);
    }

    private app.nikkisync.mobile.ui.chrome.ChromeHost createMySubpage(String title,LinearLayout body) {
        var page=new app.nikkisync.mobile.ui.chrome.ChromeHost(this);
        page.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);
        LinearLayout header=new LinearLayout(this);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(0,dp(12),0,dp(12));
        header.addView(text(title,25,true,getColor(R.color.text_primary)),new LinearLayout.LayoutParams(0,-2,1));
        Button back=button("返回");back.setOnClickListener(v->navigation.dismiss(page));header.addView(back);
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setVerticalScrollBarEnabled(false);
        body.setOrientation(LinearLayout.VERTICAL);body.setPadding(0,dp(8),0,dp(24));scroll.addView(body);
        page.contentLayer().addView(scroll,new FrameLayout.LayoutParams(-1,-1));
        page.installChrome(header,new FrameLayout(this),scroll);
        return page;
    }

    private void showSettings() {
        if(settingsPage!=null)return;
        settingsContent=new LinearLayout(this);settingsPage=createMySubpage("设置",settingsContent);
        refreshSettingsPage();
        var page=settingsPage;
        navigation.push(page,()->{page.backdrop().close();settingsPage=null;settingsContent=null;});
    }

    private void refreshSettingsPage() {
        if(settingsContent==null)return;
        settingsContent.removeAllViews();

        String device = pairedServer == null
                ? "尚未配对电脑"
                : (connectionState.isReachable() ? "已连接：" : "已配对，当前未连接：") + pairedServer.serverName();
        addMyActionCard(settingsContent,"同步与设备",device,pairedServer==null?"配对电脑":"重新配对电脑",this::startPairScanner);
        addMyActionCard(settingsContent,"连接与照片参数自查","按当前连接状态提示处理方法；照片没参数时可在详情查看路径和原因。",
                "查看自查结果",this::showTroubleshooting);

        var cacheChoices=new app.nikkisync.mobile.media.PhotoCachePreferences(this);
        addMyActionCard(settingsContent,"本地缓存","相册小缩略图与高清预览分别保留，参数更新不重复下载未变化的照片。\n缩略图上限 "+cacheChoices.thumbnailMiB()+" MiB · 高清预览上限 "+cacheChoices.previewMiB()+" MiB\n"+(imageLoader==null?"连接电脑后可缓存离线缩略图":imageLoader.offlineProgress().description()),"缓存与离线整理",this::showCacheSettings);
        addMyActionCard(settingsContent,"穿搭与参数缓存", "已读取的穿搭与参数会保留，重启后优先从手机读取，电脑更新信息时自动刷新。详情缓存上限 32 MiB；清理不影响照片和待删除记录。",
                "清理照片详情缓存", () -> {
                    NikkiSyncClient current=client;
                    if(current==null) {toast("请先选择已配对电脑");return;}
                    io.execute(() -> {
                        try {current.clearDetailCache();main.post(()->toast("详情缓存已清理，下次查看时重新读取"));}
                        catch(Exception error) {main.post(()->toast("暂时无法清理缓存"));}
                    });
                });

        addMyActionCard(settingsContent,"动态预览缓存","预览 LIVE 时在应用内暂存视频，清理后可重新读取；已保存到相册的照片和视频会保留。","清理动态预览缓存",()->io.execute(()->{
            app.nikkisync.mobile.media.live.MotionPreviewLoader.cache(this).clear();main.post(()->toast("动态预览缓存已清理"));
        }));

        boolean writeExif=getSharedPreferences("nikkisync.export",MODE_PRIVATE).getBoolean("writeExif",true);
        addMyActionCard(settingsContent,"保存时附带拍摄参数","普通 JPEG 保存时写入拍摄参数；不修改电脑原照片，LIVE 封装不受此设置影响。",
                writeExif?"已开启 · 点击关闭":"已关闭 · 点击开启",()->{
                    if(progress!=null&&progress.getVisibility()==View.VISIBLE){toast("请等待当前操作完成");return;}
                    getSharedPreferences("nikkisync.export",MODE_PRIVATE).edit().putBoolean("writeExif",!writeExif).apply();
                    refreshSettingsPage();
                });
        var marks=watermarks();
        addMyActionCard(settingsContent,"分享图昵称水印",marks.shareEnabled()?marks.shareBranding(null).title()+"\n"+marks.shareBranding(null).footer():"已关闭，分享图不包含昵称和 UID。",
                marks.shareEnabled()?"已开启 · 点击关闭":"已关闭 · 点击开启",()->{marks.setShareEnabled(!marks.shareEnabled());refreshSettingsPage();});
        addMyActionCard(settingsContent,"分享图水印文字","顶部与底部文字可独立自定义；未填写时跟随默认搭配师。","自定义分享图水印",this::editWatermark);
        addMyActionCard(settingsContent,"应用信息","当前版本 " + BuildConfig.VERSION_NAME,
                "关于&更新",this::showAboutUpdates);
        addMyActionCard(settingsContent,"诊断与反馈","导出日志、发送诊断或查收回复。",
                "诊断与反馈",this::showSupportPage);
        if(BuildConfig.STORE_SUBMISSION){
        for(String[] doc:new String[][]{{"隐私政策","privacy"},{"用户协议","terms"},{"权限与数据说明","permissions"},{"第三方服务与组件","services"}})
            addMyActionCard(settingsContent,doc[0],"离线可阅读，反馈渠道见项目仓库","查看"+doc[0],()->app.nikkisync.mobile.privacy.PrivacyUi.openDocument(this,navigation,doc[0],doc[1]));
        addMyActionCard(settingsContent,"隐私选择","撤回后退出应用；重新打开需再次选择。保留现有本地资料。","撤回同意",()->
            app.nikkisync.mobile.privacy.PrivacyUi.confirm(this,navigation,"撤回隐私同意","停止连接并退出，重新打开时再次阅读政策。","撤回并退出",()->{
                new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).withdraw();connectionState.beginSession();realtimeStop();if(discovery!=null)discovery.stop();finish();
            }));
        }
        addMyActionCard(settingsContent,"清除全部本地应用数据","删除本应用的配对、昵称、水印设置、收藏、灵感、关联和缓存；已导出到系统相册的照片不删除。此操作会退出应用。","清除全部应用数据",()->{
            if(progress!=null&&progress.getVisibility()==View.VISIBLE){toast("请等待当前操作完成");return;}
            app.nikkisync.mobile.privacy.PrivacyUi.confirm(this,navigation,"清除全部应用数据","配对、昵称、收藏、灵感和修图关联等本地记录将删除且无法撤销。系统相册及电脑原照片保留。","确认清除全部数据",()->{
                connectionState.beginSession();realtimeStop();if(discovery!=null)discovery.stop();
                ((android.app.ActivityManager)getSystemService(ACTIVITY_SERVICE)).clearApplicationUserData();
            });
        });
        if(BuildConfig.STORE_SUBMISSION)addMyActionCard(settingsContent,"APP核准（备案）信息",BuildConfig.APP_FILING_NUMBER.isEmpty()?"尚未取得备案号；此包为正式签名的提交准备版本。":"备案号："+BuildConfig.APP_FILING_NUMBER,
                "备案查询",()->openProjectLink("https://beian.miit.gov.cn/"));
    }

    private void showCacheSettings(){
        if(cacheSettingsPage!=null)return;
        cacheSettingsContent=new LinearLayout(this);cacheSettingsPage=createMySubpage("缓存与离线整理",cacheSettingsContent);
        refreshCacheSettings();var page=cacheSettingsPage;
        navigation.push(page,()->{page.backdrop().close();cacheSettingsPage=null;cacheSettingsContent=null;offlineCacheStatus=null;});
        maybeWarmOfflineCache();
    }
    private void refreshCacheSettings(){
        if(cacheSettingsContent==null)return;cacheSettingsContent.removeAllViews();
        var choices=new app.nikkisync.mobile.media.PhotoCachePreferences(this);
        offlineCacheStatus=text(imageLoader==null?"连接电脑后可缓存离线缩略图":imageLoader.offlineProgress().description(),14,true,getColor(R.color.text_primary));
        offlineCacheStatus.setPadding(dp(14),dp(8),dp(14),dp(16));cacheSettingsContent.addView(offlineCacheStatus);
        addMyActionCard(cacheSettingsContent,"离线缩略图","在线且 App 在前台时，按顺序补齐整库的小缩略图。离线可浏览、旋转和标记待删除；下载原图和未缓存的 LIVE 仍需电脑在线。空间不足会停止并提示，不会反复挤掉整库。",choices.automaticOffline()?"自动缓存已开启 · 点击暂停":"自动缓存已暂停 · 点击开启",()->{
            choices.setAutomaticOffline(!choices.automaticOffline());if(imageLoader!=null)imageLoader.pauseOfflineCaching();refreshCacheSettings();maybeWarmOfflineCache();
        });
        addMyActionCard(cacheSettingsContent,"缩略图容量上限","512 像素小图单独保存，供相册网格及离线整理使用。照片很多时可提高上限；调低会清理较早使用的小图，待删除记录与其预览保留。",choices.thumbnailMiB()+" MiB · 更改",()->chooseCacheLimit("缩略图容量上限",app.nikkisync.mobile.media.PhotoCachePreferences.THUMBNAIL_MIB,choices.thumbnailMiB(),choices::setThumbnailMiB));
        addMyActionCard(cacheSettingsContent,"高清预览容量上限","点开照片时才加载，最长边 2048 像素。清理高清预览不挤占离线小图；离线缺少高清预览时仍可用小图查看。保存原图的清晰度不受影响。",choices.previewMiB()+" MiB · 更改",()->chooseCacheLimit("高清预览容量上限",app.nikkisync.mobile.media.PhotoCachePreferences.PREVIEW_MIB,choices.previewMiB(),choices::setPreviewMiB));
        long actual=imageLoader==null?choices.effectiveMemoryBytes(Runtime.getRuntime().maxMemory())/(1024*1024):imageLoader.effectiveMemoryMiB();
        addMyActionCard(cacheSettingsContent,"图片内存缓存上限","只限制图片缓存，不是整个 App 的内存。当前实际最多 "+actual+" MiB；会根据手机可用堆上限自动收紧，系统内存紧张时释放。提高可减少反复解码，不会预先占满。",choices.memoryMiB()+" MiB · 更改",()->chooseCacheLimit("图片内存缓存上限",app.nikkisync.mobile.media.PhotoCachePreferences.MEMORY_MIB,choices.memoryMiB(),choices::setMemoryMiB));
        addMyActionCard(cacheSettingsContent,"继续缓存离线缩略图","首次补齐需要传输时间。点击后在缓存期间保持亮屏，避免自动锁屏打断；切到后台或手动锁屏仍会暂停。上方显示实际可离线浏览的张数。", "继续 / 重试缓存（保持亮屏）",()->{
            if(!connectionState.isReachable()){toast("连接电脑后才能补齐缩略图");return;}
            if(!choices.automaticOffline())choices.setAutomaticOffline(true);
            if(imageLoader!=null)imageLoader.retryOfflineCaching();refreshCacheSettings();maybeWarmOfflineCache();
            cacheWakeRequested=true;updateCacheWakeLock();
        });
        addMyActionCard(cacheSettingsContent,"其他缓存","穿搭与参数详情最多 32 MiB，LIVE 动态预览最多 256 MiB；部件图标与尚未迁移的旧版缓存最多 512 MiB。旧照片缓存会在读取时迁移。两端一起更新后，图片按内容校验，参数更新不会让缩略图失效。","返回设置",()->{if(cacheSettingsPage!=null)navigation.dismiss(cacheSettingsPage);});
    }
    private void chooseCacheLimit(String title,int[] options,int selected,java.util.function.IntConsumer change){
        LinearLayout rows=new LinearLayout(this);rows.setOrientation(LinearLayout.VERTICAL);
        Button cancel=button("取消");var sheet=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(this,text(title,20,true,getColor(R.color.text_primary)),rows,cancel).wrapContentForm();
        for(int option:options){Button item=button(option+" MiB"+(option==selected?" · 当前":""));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,dp(46));lp.bottomMargin=dp(8);rows.addView(item,lp);item.setOnClickListener(v->{
            change.accept(option);navigation.dismiss(sheet);
            if(imageLoader!=null)imageLoader.applyCacheLimits(()->{refreshCacheSettings();refreshSettingsPage();maybeWarmOfflineCache();});
            else{refreshCacheSettings();refreshSettingsPage();}
        });}
        cancel.setOnClickListener(v->navigation.dismiss(sheet));navigation.showSheet(sheet);
    }
    private void maybeWarmOfflineCache(){
        if(imageLoader==null||client==null||!connectionForeground||!connectionState.isReachable()||assets.isEmpty())return;
        String owner=app.nikkisync.mobile.storage.OrganizerStore.scope(client.server());
        imageLoader.warmThumbnails(client,assets.stream().filter(asset->!asset.isVideo()).toList(),progress->{if(owner.equals(app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer))){if(!progress.running())cacheWakeRequested=false;updateCacheWakeLock();updateGalleryCacheCount();if(offlineCacheStatus!=null)offlineCacheStatus.setText(progress.description());}});
    }
    private void updateCacheWakeLock(){
        boolean keep=cacheWakeRequested&&connectionForeground&&connectionState.isReachable()&&imageLoader!=null&&imageLoader.offlineProgress().running();
        if(keep)getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    @Override public void onTrimMemory(int level){super.onTrimMemory(level);if(imageLoader!=null&&level>=android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW)imageLoader.trimMemory();}

    private void showAboutUpdates() {
        if(aboutPage!=null)return;
        aboutContent=new LinearLayout(this);
        aboutPage=createMySubpage("关于&更新",aboutContent);
        LinearLayout author=new LinearLayout(this);
        author.setOrientation(LinearLayout.VERTICAL);
        author.setGravity(Gravity.CENTER_HORIZONTAL);
        author.setPadding(dp(18),dp(22),dp(18),dp(22));
        author.setBackgroundResource(R.drawable.bg_glass_card);
        ImageView avatar=new ImageView(this);
        avatar.setImageResource(R.drawable.author_avatar);
        avatar.setScaleType(ImageView.ScaleType.FIT_CENTER);
        avatar.setContentDescription("星尘的头像");
        author.addView(avatar,new LinearLayout.LayoutParams(dp(132),dp(132)));
        TextView appName=text("喵星图",25,true,getColor(R.color.text_primary));
        appName.setPadding(0,dp(12),0,dp(6));author.addView(appName);
        TextView version=text("版本 " + BuildConfig.VERSION_NAME + "\n构建号 " + BuildConfig.VERSION_CODE,
                13,false,getColor(R.color.text_secondary));
        version.setGravity(Gravity.CENTER);author.addView(version);
        TextView authorLabel=text("作者",13,false,getColor(R.color.text_secondary));
        authorLabel.setPadding(0,dp(18),0,dp(5));author.addView(authorLabel);
        TextView authorName=text("星尘（支持粉毛拯救世界版）",16,true,getColor(R.color.text_primary));
        authorName.setGravity(Gravity.CENTER);author.addView(authorName);
        LinearLayout.LayoutParams authorLayout=new LinearLayout.LayoutParams(-1,-2);
        authorLayout.bottomMargin=dp(10);aboutContent.addView(author,authorLayout);
        if(BuildConfig.SELF_UPDATE&&!BuildConfig.STORE_SUBMISSION){
            appUpdatePanel=new AndroidUpdatePanel(this,publicNetworkIo,this::toggleAppUpdateNotifications);
            LinearLayout.LayoutParams updateLayout=new LinearLayout.LayoutParams(-1,-2);
            updateLayout.bottomMargin=dp(10);aboutContent.addView(appUpdatePanel,updateLayout);
        }
        addMyActionCard(aboutContent,"GitHub Releases · 下载与更新","下载最新版 APK 后按系统提示手动安装；App 内不自动检查或安装更新。","打开 Releases 页",()->openProjectLink(UPDATES_URL));
        addMyActionCard(aboutContent,"开源项目","安卓端移植自 ToStardust/NikkiSync · "+PROJECT_URL,"GitHub 项目",()->openProjectLink(PROJECT_URL));
        addMyActionCard(aboutContent,"NikkiGallery · 暖暖照相馆",NIKKI_GALLERY_URL,"NikkiGallery 仓库",()->openProjectLink(NIKKI_GALLERY_URL));
        addMyActionCard(aboutContent,"RanAxro · Nikki Albums","本地参数解码组件 nuan5_decryption 的作者与项目 · "+NIKKI_ALBUMS_URL,"查看项目",()->openProjectLink(NIKKI_ALBUMS_URL));
        addMyActionCard(aboutContent,"喵星图 · Windows 桌面端","配套的 Windows 桌面相册 · "+MEOW_STAR_MAP_URL,"查看桌面端",()->openProjectLink(MEOW_STAR_MAP_URL));
        addMyActionCard(aboutContent,"NUAN5.PRO","用户开启后提供第三方在线参数解析候补 · "+NUAN5_URL,"查看服务",()->openProjectLink(NUAN5_URL));
        addMyActionCard(aboutContent,"暖暖共鸣录","历史在线部件图标与素材整理来源 · "+GONGEO_URL,"查看项目",()->openProjectLink(GONGEO_URL));
        var page=aboutPage;
        navigation.push(page,()->{
            page.backdrop().close();aboutPage=null;aboutContent=null;
            if(appUpdatePanel!=null){appUpdatePanel.close();appUpdatePanel=null;}
        });
    }

    private void toggleAppUpdateNotifications(){
        if(AndroidUpdateJob.enabled(this)){
            AndroidUpdateJob.setEnabled(this,false);
            appUpdatePanel.notificationResult("已关闭应用更新提醒。");
        }else if(android.os.Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},UPDATE_NOTIFICATION_PERMISSION);
        }else enableAppUpdateNotifications();
    }

    private void enableAppUpdateNotifications(){
        boolean enabled=AndroidUpdateJob.setEnabled(this,true);
        if(appUpdatePanel!=null)appUpdatePanel.notificationResult(enabled
                ?"已开启。Android 会在联网时定期检查。":"未能开启。请在系统设置中允许本应用的更新通知。");
    }

    private void openProjectLink(String url) {
        try {startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));}
        catch(android.content.ActivityNotFoundException error) {copyText("喵星图链接",url);}
    }

    private void showSupportPage(){
        if(supportPage!=null)return;
        var body=new LinearLayout(this);
        var panel=new SupportPanel(this,publicNetworkIo,()->diagnosticExport.launch("MomoCamera-Android-诊断.json"));
        body.addView(panel,new LinearLayout.LayoutParams(-1,-2));
        var page=createMySubpage("诊断与反馈",body);
        supportPage=page;
        navigation.push(page,()->{panel.close();page.backdrop().close();supportPage=null;});
        panel.readLatest();
    }

    private void showTroubleshooting(){
        if(troubleshootingPage!=null)return;
        troubleshootingContent=new LinearLayout(this);
        refreshTroubleshooting();
        var page=createMySubpage("常见问题自查",troubleshootingContent);
        troubleshootingPage=page;
        navigation.push(page,()->{page.backdrop().close();troubleshootingPage=null;troubleshootingContent=null;});
    }

    private void refreshTroubleshooting(){
        if(troubleshootingContent==null)return;
        var body=troubleshootingContent;
        body.removeAllViews();
        boolean paired=pairedServer!=null,reachable=connectionState.isReachable();
        addMyCard(body,"连接状态",TroubleshootingAdvice.connection(paired,reachable,connectionFailure,canDiscoverNearby()));
        if(!paired)addMyActionCard(body,"下一步","在电脑助手“手机连接”生成新二维码。","扫码配对",this::startPairScanner);
        else if(!reachable)addMyActionCard(body,"立即重试","电脑就绪后重试已保存的配对地址，不会清除相册或配对记录。","重试连接",()->{
            if(client==null)connect(pairedServer,"正在重新连接电脑…");
            else probeConnection(connectionState.session());
            toast("正在检查电脑连接");
        });
        addMyCard(body,"照片参数",TroubleshootingAdvice.metadata(null,null,reachable));
        addMyActionCard(body,"仍未解决","导出电脑端和手机端日志，描述遇到的问题及照片来源。","诊断与反馈",this::showSupportPage);
    }

    private void writeDiagnosticExport(Uri destination){
        if(destination==null)return;
        byte[] report=SupportDiagnostics.snapshot(this).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        publicNetworkIo.execute(()->{
            String message="诊断日志已保存。";
            try(var output=getContentResolver().openOutputStream(destination,"wt")){
                if(output==null)throw new java.io.IOException();
                output.write(report);
            }catch(java.io.IOException|SecurityException error){message="日志保存失败，请重新选择位置。";}
            String result=message;
            main.post(()->{if(!isDestroyed())toast(result);});
        });
    }

    private void showProfileStats() {
        if(profileStatsPage!=null)return;
        profileStatsContent=new LinearLayout(this);profileStatsPage=createMySubpage("常用穿搭",profileStatsContent);
        renderRemoteProfileStats();loadRemoteProfileStats();
        var page=profileStatsPage;
        navigation.push(page,()->{page.backdrop().close();profileStatsPage=null;profileStatsContent=null;});
    }

    private void renderRemoteProfileStats() {
        if(profileStatsContent==null)return;
        profileStatsContent.removeAllViews();
        if (client == null || !connectionState.isReachable()) {
            addMyCard(profileStatsContent,"常用穿搭", "连接电脑后显示常用套装与散件");
            return;
        }

        ProfileStatsResponse stats = profileStats;
        if (stats == null) {
            addMyCard(profileStatsContent,"常用穿搭", "正在整理穿搭…");
            return;
        }

        if (stats.topSuits().isEmpty()) {
            addMyCard(profileStatsContent,"常用套装", "当前没有可统计的套装数据");
        } else {
            List<String> labels = new ArrayList<>();
            List<Runnable> actions = new ArrayList<>();
            int rank = 1;
            for (ProfileSuitStat item : stats.topSuits()) {
                if (item.suitName() == null || item.suitName().isBlank()) continue;
                labels.add(rank++ + ". " + item.suitName() + " · " + item.photoCount() + " 张");
                actions.add(() -> openProfileSearch(item.suitName(), false));
            }
            if (labels.isEmpty()) addMyCard(profileStatsContent,"常用套装", "套装名称暂缺");
            else addMyLinkCard(profileStatsContent,"常用套装", labels, actions);
        }

        if (stats.topClothing().isEmpty()) {
            addMyCard(profileStatsContent,"常用散件", "当前没有可统计的散件数据");
        } else {
            List<String> labels = new ArrayList<>();
            List<Runnable> actions = new ArrayList<>();
            int rank = 1;
            for (ProfileClothingStat item : stats.topClothing()) {
                String name = PlayerFacingDetails.clothingName(item.name(), item.clothingId());
                if ("名称暂缺".equals(name)) continue;
                String label = rank++ + ". " + name;
                if (item.category() != null && !item.category().isBlank()) {
                    String category = ClothingSearchGrid.categoryLabel(item.category());
                    if (!category.equals(item.category())) label += " · " + category;
                }
                label += " · " + item.photoCount() + " 张";
                labels.add(label);
                String query = name;
                actions.add(() -> openProfileSearch(query, true));
            }
            if (labels.isEmpty()) addMyCard(profileStatsContent,"常用散件", "散件名称暂缺");
            else addMyLinkCard(profileStatsContent,"常用散件", labels, actions);
        }
    }

    private void loadRemoteProfileStats() {
        NikkiSyncClient current = client;
        if (current == null || !connectionState.isReachable() || profileStatsLoading) return;
        long session = connectionState.session();

        long expectedRevision = pairedServer == null ? 0 : pairedServer.lastRevision();
        if (profileStats != null && (expectedRevision <= 0 || profileStats.libraryRevision() == expectedRevision)) return;

        profileStatsLoading = true;
        io.execute(() -> {
            try {
                ProfileStatsResponse next = current.profileStats();
                main.post(() -> {
                    if (!connectionState.isCurrent(session)) return;
                    profileStats = next;
                    profileStatsLoading = false;
                    if (activeTab == TAB_MY) refreshMyPage();
                    renderRemoteProfileStats();
                });
            } catch (Exception ignored) {
                main.post(() -> { if (connectionState.isCurrent(session)) profileStatsLoading = false; });
            }
        });
    }

    private void openProfileSearch(String query, boolean clothing) {
        NikkiSyncClient current = client;
        if (current == null) {
            toast("请先连接电脑");
            return;
        }
        if (clothing) {
            SuitSearchDialog.showClothingWithContext(this, current, imageLoader, io, main, this::showViewer, query);
        } else {
            SuitSearchDialog.showSuitWithContext(this, current, imageLoader, io, main, this::showViewer, query);
        }
    }

    private void addMyLinkCard(LinearLayout target,String title, List<String> labels, List<Runnable> actions) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(13), dp(14), dp(13));
        card.setBackgroundResource(R.drawable.bg_glass_card);
        card.addView(text(title, 16, true, getColor(R.color.text_primary)));

        int count = Math.min(labels.size(), actions.size());
        for (int index = 0; index < count; index++) {
            Button row = button(labels.get(index));
            row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            row.setOnClickListener(v -> actions.get((Integer) v.getTag()).run());
            row.setTag(index);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(42)
            );
            rowLp.topMargin = dp(6);
            card.addView(row, rowLp);
        }

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(10));
        target.addView(card, lp);
    }

    private void addMyActionCard(String title, String body, String action, Runnable onClick) {
        addMyActionCard(myContent,title,body,action,onClick);
    }

    private void addMyActionCard(LinearLayout target,String title, String body, String action, Runnable onClick) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(13), dp(14), dp(13));
        card.setBackgroundResource(R.drawable.bg_glass_card);

        card.addView(text(title, 16, true, getColor(R.color.text_primary)));
        TextView content = text(body, 13, false, getColor(R.color.text_secondary));
        content.setPadding(0, dp(5), 0, 0);
        card.addView(content);

        Button actionButton = button(action);
        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(40)
        );
        actionLp.topMargin = dp(9);
        actionButton.setOnClickListener(v -> onClick.run());
        card.addView(actionButton, actionLp);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(10));
        target.addView(card, lp);
    }

    private void copyText(String label, String value) {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null) {
            toast("系统剪贴板不可用");
            return;
        }
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText(label, value));
        toast("已复制");
    }

    private void addMyCard(LinearLayout target,String title, String body) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(13), dp(14), dp(13));
        card.setBackgroundResource(R.drawable.bg_glass_card);

        card.addView(text(title, 16, true, getColor(R.color.text_primary)));
        TextView content = text(body, 13, false, getColor(R.color.text_secondary));
        content.setPadding(0, dp(5), 0, 0);
        card.addView(content);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(10));
        target.addView(card, lp);
    }

    private void updateGalleryEmptyState() {
        if (galleryEmpty == null) return;
        boolean show = adapter==null?assets.isEmpty():adapter.visiblePhotos().isEmpty();
        galleryEmpty.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) galleryEmpty.setText(!assets.isEmpty()?"当前筛选下没有照片。":pairedServer == null ? "配对电脑后，这里会显示暖暖照片。" : "当前还没有同步到照片。");
    }

    private void refreshSavedPhotos() {
        refreshSavedPhotos(false);
    }

    private void refreshSavedPhotos(boolean forceCheck) {
        if (savedAdapter == null || savedPhotoStore == null || editedVariantStore == null) return;

        List<SavedPhotoStore.Record> records = savedPhotoStore.load();
        List<EditedVariantStore.Variant> edits = editedVariantStore.loadAll();
        List<SavedPhotoGroups.Group> groups = SavedPhotoGroups.select(records, edits, savedFilter, savedSort);
        if(savedUid!=null||savedFolder!=null){Map<String,AssetSummary> sources=new LinkedHashMap<>();for(AssetSummary asset:savedSources())sources.put(asset.assetId(),asset);groups=groups.stream().filter(group->app.nikkisync.mobile.ui.PhotoScopeFilter.matches(sources.get(group.assetId()),0,savedUid,savedFolder)).toList();}
        savedAdapter.setGroups(groups);

        savedHealth.clear();
        savedHealth.putAll(savedPhotoHealthStore.load());
        savedAdapter.setHealth(savedHealth);
        updateSavedSummary(records, edits);
        updateSavedEmptyState();

        long newestCheck = 0L;
        for (SavedPhotoHealthStore.Entry entry : savedHealth.values()) {
            newestCheck = Math.max(newestCheck, entry.lastCheckedAt());
        }

        List<String> uris = new ArrayList<>();
        for (EditedVariantStore.Variant edit : edits) uris.add(edit.uri());
        boolean unchecked = records.stream().anyMatch(record -> !savedHealth.containsKey(record.uri()))
                || uris.stream().anyMatch(uri -> !savedHealth.containsKey(uri));
        if (records.isEmpty() && uris.isEmpty()) return;
        if (!forceCheck && !unchecked && System.currentTimeMillis() - newestCheck < 30_000L) return;
        final NikkiSyncClient checkClient=client;
        final long checkSession=connectionState.session();
        final boolean checkOnline=checkClient!=null&&connectionState.isReachable();

        savedHealthIo.execute(() -> {
            Map<String, SavedPhotoHealthStore.Entry> checked =
                    SavedPhotoVerifier.verify(this, savedPhotoHealthStore, records);
            checked.putAll(SavedPhotoVerifier.verifyUris(this, savedPhotoHealthStore, uris));
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                savedHealth.clear();savedHealth.putAll(checked);
                savedAdapter.setHealth(savedHealth);updateSavedSummary(records,edits);
            });
            // A missing phone file alone is not enough to discard the user's history.
            // Only a fresh, authenticated explicit PC tombstone permits removal.
            savedSourceCheckIo.execute(()->{
            List<SavedPhotoStore.Record> removeRecords=new ArrayList<>();
            List<EditedVariantStore.Variant> removeEdits=new ArrayList<>();
            if(checkOnline)for(SavedPhotoStore.Record record:records){
                var health=checked.get(record.uri());
                if(health==null||!health.isMissing())continue;
                try{boolean deleted=checkClient.sourceExplicitlyDeleted(record.assetId());
                    if(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoVerifier.checkUri(this,record.uri()),deleted)){
                    removeRecords.add(record);
                }}catch(Exception ignored){/* Offline, excluded scope and 404 remain recoverable. */}
            }
            if(checkOnline)for(EditedVariantStore.Variant edit:edits){
                var health=checked.get(edit.uri());
                if(health==null||!health.isMissing())continue;
                try{boolean deleted=checkClient.sourceExplicitlyDeleted(edit.assetId());
                    if(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoVerifier.checkUri(this,edit.uri()),deleted)){
                        removeEdits.add(edit);
                    }
                }catch(Exception ignored){/* A missing source in the current scope is not a tombstone. */}
            }
            if(!removeRecords.isEmpty()||!removeEdits.isEmpty())main.post(()->{
                if(isFinishing()||isDestroyed()||client!=checkClient||!connectionState.isCurrent(checkSession)||!connectionState.isReachable())return;
                for(var record:removeRecords){savedPhotoStore.removeIfUnchanged(record);savedPhotoHealthStore.remove(record.uri());}
                for(var edit:removeEdits){editedVariantStore.unlink(edit.variantId());savedPhotoHealthStore.remove(edit.uri());}
                refreshSavedPhotos(false);
            });
            });
        });
    }

    private void recoverHistoricalSavedPhotos() {
        NikkiSyncClient current = client;
        if (current == null) {
            toast("请先连接电脑，再找回历史保存");
            return;
        }
        if (assets.isEmpty()) {
            toast("当前图库还没有可用于匹配的照片");
            return;
        }

        savedFilterButton.setEnabled(false);
        savedSummary.setText("正在查找历史保存…");
        List<AssetSummary> snapshot = new ArrayList<>(assets);

        io.execute(() -> {
            try {
                SavedPhotoRecovery.Result result =
                        SavedPhotoRecovery.recover(this, current, snapshot, savedPhotoStore);
                main.post(() -> {
                    savedFilterButton.setEnabled(true);
                    refreshSavedPhotos();
                    String message = result.recovered() > 0
                            ? "已找回 " + result.recovered() + " 条历史保存记录"
                            : "没有发现可高置信关联的历史保存";
                    if (result.skippedAmbiguous() > 0) {
                        message += "，跳过 " + result.skippedAmbiguous() + " 条歧义匹配";
                    }
                    message += "。旧版 VIVO LIVE 因文件名不含来源信息，暂不自动关联。";
                    toast(message);
                });
            } catch (Exception error) {
                main.post(() -> {
                    savedFilterButton.setEnabled(true);
                    refreshSavedPhotos();
                    toast("历史保存找回失败：" + message(error));
                });
            }
        });
    }

    private void updateSavedSummary(
            List<SavedPhotoStore.Record> allRecords,
            List<EditedVariantStore.Variant> edits
    ) {
        if (savedSummary == null) return;
        int missing = 0;
        for (SavedPhotoStore.Record record : allRecords) {
            SavedPhotoHealthStore.Entry entry = savedHealth.get(record.uri());
            if (entry != null && entry.isMissing()) missing++;
        }
        for (EditedVariantStore.Variant edit : edits) {
            SavedPhotoHealthStore.Entry entry = savedHealth.get(edit.uri());
            if (entry != null && entry.isMissing()) missing++;
        }

        String summary = allRecords.size() + " 条保存记录";
        if (!edits.isEmpty()) summary += " · " + edits.size() + " 张修图";
        if (missing > 0) summary += " · " + missing + " 条文件缺失";
        savedSummary.setText(allRecords.size() + " 张");
        savedSummary.setContentDescription(summary);
    }

    private void updateSavedEmptyState() {
        if (savedEmpty == null || savedAdapter == null) return;
        savedEmpty.setVisibility(savedAdapter.getItemCount() == 0 ? View.VISIBLE : View.GONE);
    }

    private void confirmRemoveSavedRecord(SavedPhotoStore.Record record) {
        new AlertDialog.Builder(this).setTitle("移除保存记录？")
                .setMessage("文件可能已移动、删除或暂时无法访问。移除后只清除本应用的保存记录，不会删除手机或电脑中的照片。")
                .setNegativeButton("取消",null).setPositiveButton("移除记录",(d,w)->{
                    savedPhotoStore.removeUri(record.uri());
                    savedPhotoHealthStore.remove(record.uri());savedHealth.remove(record.uri());
                    refreshSavedPhotos();
                }).show();
    }

    private void confirmRemoveEditedRecord(EditedVariantStore.Variant variant) {
        new AlertDialog.Builder(this).setTitle("移除修图记录？")
                .setMessage("文件可能已移动、删除或暂时无法访问。只会解除本应用的关联，不会删除手机中的图片。")
                .setNegativeButton("取消",null).setPositiveButton("移除记录",(d,w)->{
                    editedVariantStore.unlink(variant.variantId());
                    savedPhotoHealthStore.remove(variant.uri());savedHealth.remove(variant.uri());
                    if(editedVariantStore.findByUri(variant.uri())==null&&!isOriginalSavedUri(variant.uri()))
                        try{getContentResolver().releasePersistableUriPermission(Uri.parse(variant.uri()),Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
                    refreshSavedPhotos();
                }).show();
    }

    private void showSavedPhotoDetails(SavedPhotoStore.Record record) {
        savedHealthIo.execute(()->{
            var state=SavedPhotoVerifier.checkUri(this,record.uri());long now=System.currentTimeMillis();
            savedPhotoHealthStore.put(record.uri(),state,now);
            main.post(()->{if(isFinishing()||isDestroyed())return;
                savedHealth.put(record.uri(),new SavedPhotoHealthStore.Entry(state,now));
                PhotoViewerPage dialog = new PhotoViewerPage(this, findThumbnail(savedList, record.uri()));
                showSavedPhotoDetails(record,dialog,savedAdapter.visiblePhotos());
            });
        });
    }
    private void showSavedPhotoDetails(SavedPhotoStore.Record record,PhotoViewerPage dialog,List<SavedPhotoGroups.Member> context) {
        cancelShareCardFrom(pendingShareCardButton);
        configureSavedViewer(dialog,record.uri(),context);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getColor(R.color.app_background));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(14), dp(12), dp(14), dp(24));
        scroll.addView(body);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        SavedPhotoHealthStore.Entry healthEntry = savedHealth.get(record.uri());
        boolean missing = healthEntry != null && healthEntry.isMissing();
        boolean unavailable = healthEntry != null && healthEntry.isUnavailable();
        header.addView(text(missing?"已删除":record.hasMotion() ? "已保存 LIVE" : "已保存照片", 20, true, getColor(R.color.text_primary)),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = button("完成");
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close);
        body.addView(header);

        ImageView preview = new ImageView(this);
        preview.setScaleType(ImageView.ScaleType.CENTER_CROP);
        preview.setBackgroundResource(R.drawable.bg_gallery_photo);
        preview.setClipToOutline(true);
        int previewSize = Math.max(dp(240), getResources().getDisplayMetrics().widthPixels - dp(28));
        LinearLayout.LayoutParams previewLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, previewSize);
        previewLp.topMargin = dp(10);
        body.addView(preview, previewLp);

        if(unavailable){AssetSummary fallback=savedSource(record.assetId());if(fallback!=null&&pairedServer!=null)
            loadViewerPhoto(fallback,preview,findAsset(record.assetId())!=null&&connectionState.isReachable());}
        else io.execute(() -> {
            try {
                android.graphics.Bitmap bitmap = app.nikkisync.mobile.media.SavedPhotoDecoder.decode(this, record.mediaUri(), 4096);
                main.post(() -> preview.setImageBitmap(bitmap));
            } catch (Exception ignored) {
                // Keep the existing image while an unavailable original is reported in details.
            }
        });

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(14), dp(14), dp(14), dp(14));
        info.setBackgroundResource(R.drawable.bg_photo_detail_glass_card);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        infoLp.topMargin = dp(10);
        body.addView(info, infoLp);

        String detail = PlayerFacingDetails.savedPhoto(record, missing);
        info.addView(text(detail, 13, false, getColor(R.color.photo_detail_text_secondary)));
        addSourceDetails(info,savedSource(record.assetId()));
        LivePhotoControls.attachSaved(this, info, record, healthEntry);

        SavedMetadataSnapshotStore.Snapshot savedSnapshot = savedMetadataSnapshotStore == null
                ? null : savedMetadataSnapshotStore.get(record.assetId());
        LinearLayout savedOutfit=new LinearLayout(this);savedOutfit.setOrientation(LinearLayout.VERTICAL);info.addView(savedOutfit);
        showSavedMetadata(savedOutfit,record.assetId(),savedSnapshot,record.hasMotion());

        Button openSystem = button(unavailable ? "系统相册文件不可访问" : "在系统相册打开");
        openSystem.setEnabled(!unavailable);
        LinearLayout.LayoutParams buttonLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonLp.topMargin = dp(10);
        openSystem.setOnClickListener(v -> {
            savedHealthIo.execute(()->{var latest=SavedPhotoVerifier.checkUri(this,record.uri());main.post(()->{
            if(latest!=SavedPhotoHealthStore.State.ACTIVE){savedPhotoHealthStore.put(record.uri(),latest,System.currentTimeMillis());
                openSystem.setEnabled(false);toast("系统相册文件已删除或暂时无法访问");refreshSavedPhotos(true);return;}
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(record.mediaUri(), "image/*");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(intent);
            } catch (Exception error) {
                toast("系统相册无法打开这张照片");
            }});});
        });
        info.addView(openSystem, buttonLp);

        Button shareSaved = button(unavailable ? "原图不可访问，无法生成分享图" : "生成分享图");
        shareSaved.setEnabled(!unavailable);
        LinearLayout.LayoutParams shareSavedLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        shareSavedLp.topMargin = dp(6);
        shareSaved.setOnClickListener(v -> {
            SavedMetadataSnapshotStore.Snapshot snapshot =
                    savedMetadataSnapshotStore == null ? null : savedMetadataSnapshotStore.get(record.assetId());
            String metadataJson = snapshot == null ? null : snapshot.metadataJson();
            String capturedAt = snapshot != null && snapshot.capturedAt() != null
                    ? snapshot.capturedAt()
                    : record.capturedAt();
            String gameVersion = snapshot != null && snapshot.gameVersion() != null
                    ? snapshot.gameVersion()
                    : record.gameVersion();
            String notice=savedShareMetadataNotice(record.assetId(),metadataJson,snapshot==null,record.hasMotion());
            confirmShareMetadata(notice,()->exportLocalShareCard(
                    shareSaved,record.mediaUri(),record.assetId(),capturedAt,gameVersion,
                    metadataJson,!notice.isBlank()));
        });
        info.addView(shareSaved, shareSavedLp);
        dialog.addAction("分享", () -> { if (shareSaved.isEnabled()) shareSaved.performClick(); });

        Button linkEdit = button("关联修图");
        LinearLayout.LayoutParams linkEditLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        linkEditLp.topMargin = dp(6);
        linkEdit.setOnClickListener(v -> {
            dialog.dismiss();
            startEditedPhotoLink(record);
        });
        info.addView(linkEdit, linkEditLp);

        AssetSummary source = findAsset(record.assetId());
        if(unavailable){
            Button restore=button("重新保存");restore.setEnabled(source!=null&&connectionState.isReachable());
            LinearLayout.LayoutParams restoreLp=new LinearLayout.LayoutParams(-1,-2);restoreLp.topMargin=dp(6);
            restore.setOnClickListener(v->{if(source!=null&&connectionState.isReachable()){dialog.dismiss();requestPhotoSave(List.of(source),false);}});
            info.addView(restore,restoreLp);dialog.addAction("保存",source!=null&&connectionState.isReachable(),restore::performClick);
            if(!restore.isEnabled())info.addView(text("连接原电脑后可重新保存。",12,false,getColor(R.color.photo_detail_text_secondary)));
        }
        if (source != null) {
            Button sourceButton = button("查看源照片");
            LinearLayout.LayoutParams sourceLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            sourceLp.topMargin = dp(6);
            sourceButton.setOnClickListener(v -> showViewer(source));
            info.addView(sourceButton, sourceLp);
        }

        Button removeRecord = button("仅移除 NikkiSync 记录");
        LinearLayout.LayoutParams removeLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        removeLp.topMargin = dp(6);
        removeRecord.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("移除保存记录？")
                .setMessage("只会从 NikkiSync 的“已保存”中移除记录，不会删除系统相册里的照片。")
                .setNegativeButton("取消", null)
                .setPositiveButton("移除", (d, which) -> {
                    savedPhotoStore.removeUri(record.uri());
                    savedPhotoHealthStore.remove(record.uri());
                    savedHealth.remove(record.uri());
                    dialog.dismiss();
                    refreshSavedPhotos();
                })
                .show());
        info.addView(removeRecord, removeLp);

        dialog.setOnDismissListener(() -> cancelShareCardFrom(shareSaved));
        dialog.setContentView(scroll);
        if(record.hasMotion()&&!unavailable)dialog.setLivePhoto(app.nikkisync.mobile.media.live.MotionPreviewLoader.saved(this,record));
        preloadSavedNeighbors(dialog,record.uri(),context);
        dialog.show();
    }

    private void showEditedPhotoDetails(EditedVariantStore.Variant variant) {
        PhotoViewerPage dialog = new PhotoViewerPage(this, findThumbnail(savedList, variant.uri()));
        showEditedPhotoDetails(variant,dialog,savedAdapter.visiblePhotos());
    }
    private void showEditedPhotoDetails(EditedVariantStore.Variant variant,PhotoViewerPage dialog,List<SavedPhotoGroups.Member> context) {
        cancelShareCardFrom(pendingShareCardButton);
        configureSavedViewer(dialog,variant.uri(),context);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getColor(R.color.app_background));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(14), dp(12), dp(14), dp(24));
        scroll.addView(body);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(text("修图版", 20, true, getColor(R.color.text_primary)),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = button("完成");
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close);
        body.addView(header);

        ImageView preview = new ImageView(this);
        preview.setScaleType(ImageView.ScaleType.CENTER_CROP);
        preview.setBackgroundResource(R.drawable.bg_gallery_photo);
        preview.setClipToOutline(true);
        int previewSize = Math.max(dp(240), getResources().getDisplayMetrics().widthPixels - dp(28));
        LinearLayout.LayoutParams previewLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                previewSize
        );
        previewLp.topMargin = dp(10);
        body.addView(preview, previewLp);

        io.execute(() -> {
            try {
                android.graphics.Bitmap bitmap = app.nikkisync.mobile.media.SavedPhotoDecoder.decode(this,
                        Uri.parse(variant.uri()), 4096);
                main.post(() -> preview.setImageBitmap(bitmap));
            } catch (Exception ignored) {
                // Keep any already displayed image when the edited original is unavailable.
            }
        });

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(14), dp(14), dp(14), dp(14));
        info.setBackgroundResource(R.drawable.bg_photo_detail_glass_card);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        infoLp.topMargin = dp(10);
        body.addView(info, infoLp);

        SavedPhotoHealthStore.Entry healthEntry = savedHealth.get(variant.uri());
        boolean missing = healthEntry != null && healthEntry.isMissing();
        String detail = PlayerFacingDetails.editedPhoto(variant, missing);
        info.addView(text(detail, 13, false, getColor(R.color.photo_detail_text_secondary)));
        addSourceDetails(info,savedSource(variant.assetId()));

        LinearLayout params = new LinearLayout(this);
        params.setOrientation(LinearLayout.VERTICAL);
        params.setPadding(0, dp(12), 0, dp(8));
        params.setVisibility(View.GONE);
        info.addView(params);

        SavedMetadataSnapshotStore.Snapshot cached =
                savedMetadataSnapshotStore == null ? null : savedMetadataSnapshotStore.get(variant.assetId());
        showSavedMetadata(params,variant.assetId(),cached);

        AssetSummary currentSource = findAsset(variant.assetId());
        NikkiSyncClient currentClient = client;
        if (currentClient != null) {
            io.execute(() -> {
                try {
                    AssetDetail online = currentClient.asset(variant.assetId());
                    String capturedAt = currentSource != null
                            ? currentSource.capturedAt()
                            : cached == null ? null : cached.capturedAt();
                    String gameVersion = currentSource != null
                            ? currentSource.gameVersion()
                            : cached == null ? null : cached.gameVersion();
                    cacheMetadataSnapshot(variant.assetId(), capturedAt, gameVersion, online);
                    main.post(() -> showSavedOutfit(params, variant.assetId(), online.metadataJson()));
                } catch (Exception ignored) {}
            });
        }

        SavedPhotoStore.Record original = findOriginalSavedRecord(variant.assetId());
        Button originalButton = button(original == null ? "原始保存图记录不存在" : "查看原始保存图");
        originalButton.setEnabled(original != null);
        LinearLayout.LayoutParams originalLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        originalLp.topMargin = dp(8);
        originalButton.setOnClickListener(v -> {
            if (original == null) return;
            dialog.dismiss();
            showSavedPhotoDetails(original);
        });
        info.addView(originalButton, originalLp);

        AssetSummary source = findAsset(variant.assetId());
        if (source != null) {
            Button sourceButton = button("查看源照片");
            LinearLayout.LayoutParams sourceLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            );
            sourceLp.topMargin = dp(6);
            sourceButton.setOnClickListener(v -> {
                dialog.dismiss();
                showViewer(source);
            });
            info.addView(sourceButton, sourceLp);
        }

        Button shareEdited = button(missing ? "修图不可访问，无法生成分享图" : "生成分享图");
        shareEdited.setEnabled(!missing);
        LinearLayout.LayoutParams shareEditedLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        shareEditedLp.topMargin = dp(8);
        shareEdited.setOnClickListener(v -> {
            SavedMetadataSnapshotStore.Snapshot snapshot =
                    savedMetadataSnapshotStore == null ? null : savedMetadataSnapshotStore.get(variant.assetId());
            SavedPhotoStore.Record originalForShare = findOriginalSavedRecord(variant.assetId());
            String capturedAt = snapshot != null && snapshot.capturedAt() != null
                    ? snapshot.capturedAt()
                    : originalForShare == null ? null : originalForShare.capturedAt();
            String gameVersion = snapshot != null && snapshot.gameVersion() != null
                    ? snapshot.gameVersion()
                    : originalForShare == null ? null : originalForShare.gameVersion();
            String metadataJson=snapshot==null?null:snapshot.metadataJson();
            String notice=savedShareMetadataNotice(variant.assetId(),metadataJson,snapshot==null,original!=null&&original.hasMotion());
            confirmShareMetadata(notice,()->exportLocalShareCard(
                    shareEdited,Uri.parse(variant.uri()),variant.assetId(),capturedAt,gameVersion,
                    metadataJson,!notice.isBlank()));
        });
        info.addView(shareEdited, shareEditedLp);
        dialog.addAction("分享", () -> { if (shareEdited.isEnabled()) shareEdited.performClick(); });

        Button unlink = button("解除关联");
        LinearLayout.LayoutParams unlinkLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        unlinkLp.topMargin = dp(8);
        unlink.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("解除修图关联？")
                .setMessage("只会移除 NikkiSync 内的关联，不会删除或修改系统相册里的图片。")
                .setNegativeButton("取消", null)
                .setPositiveButton("解除关联", (d, which) -> {
                    String uri = variant.uri();
                    boolean removed = editedVariantStore.unlink(variant.variantId());
                    if (!removed) {
                        toast("关联记录已不存在");
                        return;
                    }
                    savedPhotoHealthStore.remove(uri);
                    savedHealth.remove(uri);
                    if (editedVariantStore.findByUri(uri) == null && !isOriginalSavedUri(uri)) {
                        try {
                            getContentResolver().releasePersistableUriPermission(
                                    Uri.parse(uri),
                                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        } catch (Exception ignored) {}
                    }
                    dialog.dismiss();
                    refreshSavedPhotos();
                    toast("已解除关联，系统相册中的图片未删除");
                })
                .show());
        info.addView(unlink, unlinkLp);

        dialog.setOnDismissListener(() -> cancelShareCardFrom(shareEdited));
        dialog.setContentView(scroll);
        preloadSavedNeighbors(dialog,variant.uri(),context);
        dialog.show();
    }

    private SavedPhotoStore.Record findOriginalSavedRecord(String assetId) {
        SavedPhotoStore.Record fallback = null;
        for (SavedPhotoStore.Record record : savedPhotoStore.load()) {
            if (!record.assetId().equals(assetId)) continue;
            if (fallback == null) fallback = record;
            SavedPhotoHealthStore.Entry health = savedHealth.get(record.uri());
            if (health == null || !health.isMissing()) return record;
        }
        return fallback;
    }

    private boolean isOriginalSavedUri(String uri) {
        for (SavedPhotoStore.Record record : savedPhotoStore.load()) {
            if (record.uri().equals(uri)) return true;
        }
        return false;
    }

    private void exportRemoteShareCard(
            Button button,
            NikkiSyncClient current,
            AssetSummary asset,
            String metadataJson
    ) {
        startShareCardWork(button);
        int savedRotation=rotationByAssetId.getOrDefault(asset.assetId(),0);
        LivePhotoProfile profile=LivePhotoControls.selectedProfile(this);
        ShareCardExportCoordinator.OriginalSave original=progress->{
            Uri uri;
            if(asset.hasMotion()){
                var result=LivePhotoExporter.save(this,current,asset,savedRotation,profile,(stage,percent)->progress.update(stage,percent,percent>0?100:0));
                uri=result.primaryUri();savedPhotoStore.recordMotion(asset,uri,result.companionUris(),savedRotation,result.savedFormat(),result.profileId(),result.presentationUs(),result.timestampSource());
            }else{uri=originalSaver.save(this,current,asset,savedRotation,progress);savedPhotoStore.record(asset,uri,savedRotation,"原始照片");}
            try{cacheMetadataSnapshot(asset.assetId(),asset.capturedAt(),asset.gameVersion(),current.asset(asset.assetId()));}catch(Exception ignored){}
            main.post(()->{if(!isFinishing()&&!isDestroyed())refreshSavedPhotos();});return uri;
        };
        shareCardExportCoordinator.exportRemote(
                current,
                asset,
                metadataJson,
                rotationByAssetId.getOrDefault(asset.assetId(), 0),
                shareCardListener(button, !PlayerFacingDetails.metadataNoticeForAsset(asset,metadataJson).isBlank(),original)
        );
    }

    private String savedShareMetadataNotice(String assetId,String metadataJson,boolean snapshotMissing,boolean savedLive){
        AssetSummary source=savedSource(assetId);
        if(snapshotMissing&&(source==null?!savedLive:source.hasMetadata()))
            return "这张照片尚未缓存参数，当前分享图只能包含已有信息。连接电脑后再生成可显示完整穿搭。";
        return PlayerFacingDetails.metadataNoticeForAsset(source,metadataJson,savedLive);
    }

    private void confirmShareMetadata(String notice,Runnable export){
        if(notice==null||notice.isBlank()){export.run();return;}
        AdviceDialog.show(this,"分享图缺少参数",notice+"\n继续生成将显示已有信息。",
                "继续生成",export,"取消",null);
    }

    private void exportLocalShareCard(
            Button button,
            Uri backgroundUri,
            String assetId,
            String capturedAt,
            String gameVersion,
            String metadataJson,
            boolean metadataMissing
    ) {
        startShareCardWork(button);
        shareCardExportCoordinator.exportLocal(
                client,
                backgroundUri,
                assetId,
                capturedAt,
                gameVersion,
                metadataJson,
                shareCardListener(button, metadataMissing,progress->{
                    progress.update("确认原图已在相册",0,0);
                    try(var input=getContentResolver().openInputStream(backgroundUri)){if(input==null)throw new IllegalStateException("原图已不可读取");}
                    return backgroundUri;
                })
        );
    }

    private ShareCardExportCoordinator.Listener shareCardListener(Button button, boolean metadataMissing,ShareCardExportCoordinator.OriginalSave original) {
        return new ShareCardExportCoordinator.Listener() {
            @Override public void onProgress(String stage,long done,long total) {
                if(isFinishing()||isDestroyed()||pendingShareCardButton!=button)return;
                if(shareProgress!=null)shareProgress.update(stage,done,total);
            }
            @Override public void onSuccess(ShareCardPreparation.Prepared prepared) {
                if (isFinishing() || isDestroyed()) { prepared.close(); return; }
                if(shareProgress!=null){shareProgress.dismiss();shareProgress=null;}
                setShareCardBusy(button, false);
                if (shareCardPreview != null) shareCardPreview.dismiss();
                shareCardPreview = new ShareCardPreviewDialog(MainActivity.this, prepared,
                        shareCardExportCoordinator, shareWorker, metadataMissing,original);
                shareCardPreview.show();
            }

            @Override public void onFailure(Exception error) {
                if (isFinishing() || isDestroyed()) return;
                SupportDiagnostics.record(MainActivity.this,SupportDiagnostics.ErrorCode.SHARE_EXPORT);
                if(shareProgress!=null){shareProgress.dismiss();shareProgress=null;}
                setShareCardBusy(button, false);
                toast("分享图生成失败：" + message(error));
            }
        };
    }

    private void setShareCardBusy(Button button, boolean busy) {
        button.setEnabled(!busy);
        button.setText(busy ? "正在生成分享图…" : "生成分享图");
    }
    private void startShareCardWork(Button button) {
        if (pendingShareCardButton != null) setShareCardBusy(pendingShareCardButton, false);
        if (shareCardPreview != null) shareCardPreview.dismiss();
        pendingShareCardButton = button;
        setShareCardBusy(button, true);
        if(shareProgress!=null)shareProgress.dismiss();
        shareProgress=new app.nikkisync.mobile.ui.OperationProgressDialog(this,"生成穿搭与参数分享图",()->cancelShareCardFrom(button));
        shareProgress.show();
    }
    private void cancelShareCardFrom(Button source) {
        if (source == null || pendingShareCardButton != source) return;
        shareCardExportCoordinator.cancel();
        if(shareProgress!=null){shareProgress.dismiss();shareProgress=null;}
        if (shareCardPreview != null) shareCardPreview.dismiss();
        setShareCardBusy(source, false);
        pendingShareCardButton = null;
    }

    private void showSavedOutfit(LinearLayout target, String assetId, String metadataJson) {
        showSavedOutfit(target,assetId,metadataJson,false);
    }

    private void showSavedOutfit(LinearLayout target, String assetId, String metadataJson,boolean savedLive) {
        renderClothingSection(assetId,metadataJson,target,savedSource(assetId),savedLive);
        String summary=SavedMetadataText.summary(metadataJson);
        if(target.getVisibility()==View.GONE&&!summary.isBlank()){
            TextView details=text(summary,13,false,getColor(R.color.photo_detail_text_secondary));
            details.setPadding(0,dp(12),0,dp(8));target.addView(details,0);target.setVisibility(View.VISIBLE);
        }
    }

    private void showSavedMetadata(LinearLayout target,String assetId,SavedMetadataSnapshotStore.Snapshot snapshot) {
        showSavedMetadata(target,assetId,snapshot,false);
    }

    private void showSavedMetadata(LinearLayout target,String assetId,SavedMetadataSnapshotStore.Snapshot snapshot,boolean savedLive) {
        if(snapshot!=null){showSavedOutfit(target,assetId,snapshot.metadataJson(),savedLive);return;}
        AssetSummary source=savedSource(assetId);
        if(source==null?savedLive:!source.hasMetadata())showSavedOutfit(target,assetId,null,savedLive);
        else showMetadataNotice(target,"尚未缓存这张照片的参数，连接电脑后可读取。");
    }

    private void cacheMetadataSnapshot(
            String assetId,
            String capturedAt,
            String gameVersion,
            AssetDetail detail
    ) {
        if(detail!=null)stylistProfiles().rememberMetadata(detail.metadataJson());
        if (savedMetadataSnapshotStore == null || detail == null
                || detail.metadataJson() == null || detail.metadataJson().isBlank()) return;
        SavedMetadataSnapshotStore.Snapshot previous = savedMetadataSnapshotStore.get(assetId);
        String finalCapturedAt = capturedAt != null && !capturedAt.isBlank()
                ? capturedAt
                : previous == null ? null : previous.capturedAt();
        String finalGameVersion = gameVersion != null && !gameVersion.isBlank()
                ? gameVersion
                : previous == null ? null : previous.gameVersion();
        savedMetadataSnapshotStore.put(new SavedMetadataSnapshotStore.Snapshot(
                assetId,
                detail.metadataJson(),
                finalCapturedAt,
                finalGameVersion,
                System.currentTimeMillis()
        ));
    }

    private AssetSummary findAsset(String assetId) {
        for (AssetSummary asset : assets) if (asset.assetId().equals(assetId)) return asset;
        return null;
    }

    private void handleIntent(Intent intent) {
        if(intent!=null&&AndroidUpdateJob.OPEN_UPDATES.equals(intent.getAction())&&!BuildConfig.STORE_SUBMISSION){
            showAboutUpdates();
            appUpdatePanel.check();
            return;
        }
        if (intent != null && app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.OPEN_PHOTO.equals(intent.getAction())) {
            switchTab(TAB_SAVED);
            String uri = intent.getStringExtra(app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.PHOTO_URI);
            for (SavedPhotoStore.Record record : savedPhotoStore.load()) {
                if (record.uri().equals(uri)) { main.post(() -> { if (!isFinishing() && !isDestroyed()) showSavedPhotoDetails(record); }); break; }
            }
            return;
        }
        if (intent == null || intent.getData() == null) return;
        String raw = intent.getDataString();
        if (raw != null && raw.startsWith("nikki-sync://pair?")) beginPair(raw);
    }

    private void startEditedPhotoLink(SavedPhotoStore.Record original) {
        pendingEditedLinkSource = original;
        editedPhotoPicker.launch(new PickVisualMediaRequest.Builder()
                .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE)
                .build());
    }

    private void handleEditedPhotoSelection(List<Uri> uris) {
        SavedPhotoStore.Record source = pendingEditedLinkSource;
        pendingEditedLinkSource = null;
        if (source == null || uris == null || uris.isEmpty()) return;

        List<Uri> selected = new ArrayList<>(uris);
        io.execute(() -> {
            int added = 0;
            int duplicates = 0;
            int conflicts = 0;
            int limitedAccess = 0;
            int failed = 0, written = 0, withoutExif = 0, updated = 0;
            long baseTime = System.currentTimeMillis();
            // Refresh the canonical source before exporting, retaining the offline snapshot on failure.
            NikkiSyncClient current = client;
            if(current!=null)try{
                cacheMetadataSnapshot(source.assetId(),source.capturedAt(),source.gameVersion(),current.asset(source.assetId()));
            }catch(Exception ignored){}
            SavedMetadataSnapshotStore.Snapshot snapshot=savedMetadataSnapshotStore.get(source.assetId());

            for (int index = 0; index < selected.size(); index++) {
                Uri uri = selected.get(index);
                if (uri == null) continue;
                app.nikkisync.mobile.media.EditedPhotoExif.Result prepared=null;
                try {
                    var existing=editedVariantStore.findByUri(uri.toString());
                    if(existing!=null&&!existing.assetId().equals(source.assetId())){conflicts++;continue;}
                    EditedMediaAccess.Info media = EditedMediaAccess.describeAndPersist(this, uri);
                    prepared=app.nikkisync.mobile.media.EditedPhotoExif.prepare(this,uri,media.mimeType(),snapshot,source.capturedAt(),source.gameVersion());
                    if(existing!=null){
                        if(prepared.written()){
                            if(!editedVariantStore.replaceMedia(existing.variantId(),prepared.uri().toString()))throw new java.io.IOException("关联已移除");
                            updated++;
                        }else duplicates++;
                        continue;
                    }
                    if (!prepared.copied() && !media.persistGranted()) limitedAccess++;
                    EditedVariantStore.LinkResult result = editedVariantStore.linkSelected(
                            source.assetId(),
                            source.uri(),
                            prepared.uri().toString(),
                            media.uri(),
                            baseTime + index,
                            media.displayName(),
                            media.mimeType()
                    );
                    if (result.status() == EditedVariantStore.LinkStatus.ADDED) {added++;if(prepared.written())written++;else withoutExif++;}
                    else {
                        app.nikkisync.mobile.media.EditedPhotoExif.discard(this,prepared);
                        if (result.status() == EditedVariantStore.LinkStatus.DUPLICATE) duplicates++;else conflicts++;
                    }
                } catch (Exception ignored) {
                    app.nikkisync.mobile.media.EditedPhotoExif.discard(this,prepared);
                    failed++;
                }
            }

            int finalAdded = added;
            int finalDuplicates = duplicates;
            int finalConflicts = conflicts;
            int finalLimitedAccess = limitedAccess;
            int finalFailed=failed, finalWritten=written, finalWithoutExif=withoutExif, finalUpdated=updated;
            main.post(() -> {
                refreshSavedPhotos();
                StringBuilder result = new StringBuilder();
                if (finalAdded > 0) result.append("已关联 ").append(finalAdded).append(" 张修图");
                if(finalWritten>0)result.append("，已生成 ").append(finalWritten).append(" 张带 EXIF 的无损副本");
                if(finalUpdated>0)result.append("，已补写 ").append(finalUpdated).append(" 张既有关联的 EXIF 副本");
                if(finalWithoutExif>0)result.append("。").append(finalWithoutExif).append(" 张仅关联：EXIF 已关闭或格式不支持写入");
                if(finalFailed>0)result.append("。").append(finalFailed).append(" 张写入或保存失败，未新增关联，请重试");
                if((finalAdded>0||finalUpdated>0)&&snapshot==null)result.append("。源照片参数尚未缓存，未补入拍摄与搭配参数，请连接电脑后重试关联");
                if (finalDuplicates > 0) {
                    if (result.length() > 0) result.append("，");
                    result.append("跳过 ").append(finalDuplicates).append(" 张重复图片");
                }
                if (finalConflicts > 0) {
                    if (result.length() > 0) result.append("，");
                    result.append(finalConflicts).append(" 张已关联到其他照片");
                }
                if (finalLimitedAccess > 0) {
                    if (result.length() > 0) result.append("。");
                    result.append("部分图片的长期访问权限由系统相册提供方决定");
                }
                if (result.length() == 0) result.append("没有新增关联");
                toast(result.toString());
            });
        });
    }

    private void loadOfflineLibrary(PairedServer server,long session){
        if(organizer==null)return;
        organizerIo.execute(()->{List<AssetSummary> snapshot=organizer.library(app.nikkisync.mobile.storage.OrganizerStore.scope(server));List<AssetSummary> cached=imageLoader.cachedAssets(server,snapshot);
            main.post(()->{if(!connectionState.isCurrent(session)||libraryLoadedForSession&&connectionState.isReachable())return;imageLoader.offlineSnapshot(cached.size(),(int)snapshot.stream().filter(asset->!asset.isVideo()).count());assets.clear();assets.addAll(cached);renderGallery();countLabel.setText("离线 · 已缓存 "+cached.size()+" 张");refreshOrganizer();updateGalleryEmptyState();});});
    }
    private void refreshOrganizer(){
        if(organizer==null||pairedServer==null)return;String scope=app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer);
        organizerIo.execute(()->{var entries=organizer.entries(scope);main.post(()->{if(!scope.equals(app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer)))return;
            organizerWorkPending=entries.stream().anyMatch(entry->entry.pending()||entry.state().equals("executing")||entry.state().equals("cancel_requested"));
            if(recentDeletedButton!=null){recentDeletedButton.setEnabled(!entries.isEmpty());recentDeletedButton.setText("最近删除");}
            List<AssetSummary> visible=new ArrayList<>();for(var asset:filteredGallery())if(entries.stream().noneMatch(entry->entry.asset().assetId().equals(asset.assetId())&&(entry.pending()||entry.state().equals("executing")||(entry.state().equals("recycled")&&entry.asset().revision()>=asset.revision()))))visible.add(asset);
            adapter.setItems(visible,recentPhotoIds);updateSelection();updateGalleryEmptyState();if(organizerPage!=null&&organizerPage.isOpen()){organizerPage.setSyncFailure(organizerSyncFailure);organizerPage.refresh();}
        });});
    }
    private void queueDeletion(List<AssetSummary> selection){
        if(organizer==null||pairedServer==null||selection.isEmpty())return;
        List<AssetSummary> chosen=List.copyOf(selection);PairedServer owner=pairedServer;String scope=app.nikkisync.mobile.storage.OrganizerStore.scope(owner);
        app.nikkisync.mobile.privacy.PrivacyUi.confirm(this,navigation,"加入最近删除","将 "+chosen.size()+" 张照片加入待删除清单。现在不会删除电脑或手机照片；可在已保存 → 最近删除中取消。重连后仍须电脑确认，才会移入回收站。","加入待删除",()->organizerIo.execute(()->{
            try{organizer.enqueue(scope,chosen);imageLoader.pinForOrganizerAsync(owner,chosen);main.post(()->{adapter.clearSelection();refreshOrganizer();syncOrganizer();toast("已记录，可在已保存 → 最近删除中取消");});}
            catch(Exception error){main.post(()->toast("无法记录："+message(error)));}
        }));
    }
    private void syncOrganizer(){
        if(organizer==null||client==null||!connectionState.isReachable())return;
        if(organizerSyncing){organizerSyncAgain=true;return;}
        NikkiSyncClient current=client;String scope=app.nikkisync.mobile.storage.OrganizerStore.scope(current.server());organizerSyncing=true;
        organizerNetworkIo.execute(()->{boolean followUp=false;String failure=null;try{var requests=organizer.outgoing(scope);var results=current.syncOrganizer(requests);if(results.length()>0)organizer.acknowledge(scope,results);followUp=app.nikkisync.mobile.storage.OrganizerStore.needsFollowUp(requests,results);}
            catch(Exception error){failure=app.nikkisync.mobile.net.OrganizerSyncFailure.message(error);android.util.Log.w("NikkiSync-Organizer","Organizer sync unavailable: "+error.getClass().getSimpleName());}
            finally{boolean challenge=followUp;String outcome=failure;main.post(()->{organizerSyncing=false;boolean again=organizerSyncAgain||challenge;organizerSyncAgain=false;if(client==current)organizerSyncFailure=outcome;refreshOrganizer();if(again&&connectionForeground&&client==current&&!isDestroyed())main.postDelayed(this::syncOrganizer,125);});}});
    }
    private void startPairScanner() {
        startActivityForResult(new Intent(this, PairQrScannerActivity.class), PAIR_QR_SCAN);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PAIR_QR_SCAN || resultCode != RESULT_OK || data == null) return;
        String raw = data.getStringExtra(PairQrScannerActivity.EXTRA_PAIRING_URI);
        if (raw != null) beginPair(raw);
    }

    private void beginPair(String raw) {
        final PairingPayload payload;
        try { payload = PairingUri.parse(raw); }
        catch (Exception error) { toast(error.getMessage()); return; }
        setBusy(true); setStatus("正在与电脑建立一次性配对…");
        io.execute(() -> {
            try {
                PairedServer server = NikkiSyncClient.pair(payload, identity);
                serverStore.save(server);
                main.post(() -> { setBusy(false); connect(server, "配对成功 · 正在读取图库…"); updatePairButton(); updateGalleryEmptyState(); });
            } catch (Exception error) {
                SupportDiagnostics.record(this,SupportDiagnostics.ErrorCode.PAIR_FAILED);
                main.post(() -> { setBusy(false); setStatus("配对失败 · 请检查连接后重试");
                    toast("配对失败。请确认电脑助手仍在运行、两端处于同一局域网，并重新扫描未过期的二维码。设置中可查看连接自查。"); });
            }
        });
    }

    private void connect(PairedServer server, String message) {
        inspirationEpoch.incrementAndGet();lastInspirationAttempt=0;
        long session = connectionState.beginSession();
        libraryLoadedForSession=false;libraryLoading=false;connectionFailure=null;organizerSyncFailure=null;
        android.util.Log.i("NikkiSync-Connection","Starting paired connection session");
        String previousScope=app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer);
        pairedServer = server; profileStats = null; profileStatsLoading = false; connectionProbePending = false;
        recentPhotoIds = recentPhotoBatchStore == null ? Set.of() : recentPhotoBatchStore.load(app.nikkisync.mobile.storage.OrganizerStore.scope(server));
        refreshViewerConnections();
        adapter.setOfflineServer(server);
        if(!previousScope.equals(app.nikkisync.mobile.storage.OrganizerStore.scope(server))){assets.clear();adapter.setItems(List.of());organizerPage=null;}
        setStatus(message); realtimeStop();
        if (activeTab == TAB_MY) refreshMyPage();
        try {
            client = new NikkiSyncClient(server, identity, app.nikkisync.mobile.storage.AssetDetailCache.shared(this));
            imageLoader.setNetworkAvailable(false);
            loadOfflineLibrary(server,session);
            loadLibrary(message);
            realtime = new RealtimeWebSocket(client.signedHttp(), server, new RealtimeWebSocket.Listener() {
                @Override public void onText(String json) {
                    main.post(() -> { if (connectionState.isCurrent(session)) handleRealtime(json); });
                }
                @Override public void onConnectionState(boolean connected) {
                    main.post(() -> {
                        if (!connectionState.isCurrent(session)) return;
                        connectionState.realtimeResult(session, connected);
                        renderConnectionStatus();
                        if (!connected) probeConnection(session);
                        else {
                            onConnectionAvailable();
                            if(!libraryLoadedForSession)loadLibrary("已重新连接 · 正在读取图库…");
                            else {syncChanges();syncOrganizer();}
                        }
                    });
                }
            });
            realtime.start();
        } catch (Exception error) { setStatus("连接初始化失败"); toast("连接初始化失败，请在设置中打开连接自查后重试。"); }
    }

    private void loadLibrary(String message) {
        loadLibrary(message,false);
    }
    private void loadLibrary(String message,boolean force) {
        if(libraryLoading)return;
        long session = connectionState.session();
        NikkiSyncClient current = client;
        if (current == null) { if (pairedServer == null) startPairScanner(); return; }
        libraryLoading=true;setBusy(true); setStatus(message);
        io.execute(() -> {
            try {
                var snapshot=app.nikkisync.mobile.net.LibraryPager.read(current::assets,()->connectionState.isCurrent(session),count->main.post(()->{
                    if(connectionState.isCurrent(session)&&libraryLoading&&countLabel!=null)countLabel.setText("已读取 "+count+" 张…");
                }),force||organizer==null?null:organizer.snapshot(app.nikkisync.mobile.storage.OrganizerStore.scope(current.server())));
                List<AssetSummary> next=snapshot.items();
                if(next.isEmpty())imageLoader.offlineSnapshot(0,0);
                if(!connectionState.isCurrent(session))throw new java.util.concurrent.CancellationException();
                Set<String> updatedRecent = null;
                if(organizer!=null&&!snapshot.fromSnapshot()){
                    String scope=app.nikkisync.mobile.storage.OrganizerStore.scope(current.server());var previous=organizer.libraryIds(scope);
                    boolean hasBaseline=!previous.isEmpty()||organizer.snapshot(scope)!=null;
                    try{if(savedSourceStore!=null&&savedPhotoStore!=null){java.util.Set<String> savedIds=new java.util.HashSet<>();for(var record:savedPhotoStore.load())savedIds.add(record.assetId());if(editedVariantStore!=null)for(var variant:editedVariantStore.loadAll())savedIds.add(variant.assetId());List<AssetSummary> savedSources=new ArrayList<>(organizer.libraryForIds(scope,savedIds));for(AssetSummary asset:next)if(savedIds.contains(asset.assetId()))savedSources.add(asset);savedSourceStore.putAll(savedSources);}}catch(Exception ignored){}
                    imageLoader.reconcileLibraryIds(current.server(),previous,next);
                    if(!connectionState.isCurrent(session))throw new java.util.concurrent.CancellationException();
                    if(recentPhotoBatchStore!=null)updatedRecent=recentPhotoBatchStore.reconcile(scope,previous,hasBaseline,next);
                    organizer.remember(scope,next,snapshot.baselineRevision());
                }
                if(!connectionState.isCurrent(session))throw new java.util.concurrent.CancellationException();
                Set<String> finalRecent=updatedRecent;
                long finalRevision = snapshot.baselineRevision();
                main.post(() -> {
                    if (!connectionState.isCurrent(session)) return;
                    libraryLoading=false;libraryLoadedForSession=true;connectionFailure=null;
                    serverStore.updateRevision(finalRevision);
                    if (pairedServer != null) pairedServer = pairedServer.withRevision(finalRevision);
                    if(finalRecent!=null)recentPhotoIds=finalRecent;
                    assets.clear(); assets.addAll(next); renderGallery(); updateGalleryCacheCount();
                    connectionState.httpResult(session, true);
                    setBusy(false); renderConnectionStatus(); updateSelection(); updateGalleryEmptyState();
                    if(activeTab==TAB_SAVED)refreshSavedPhotos(true);
                    maybeWarmOfflineCache();
                    refreshOrganizer();syncOrganizer();
                    syncInspirations(true);
                    refreshKnownEndpoints(current,session);
                    if(snapshot.fromSnapshot()||snapshot.latestRevision()>finalRevision)main.post(()->{if(connectionState.isCurrent(session))syncChanges();});
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (!connectionState.isCurrent(session)) return;
                    libraryLoading=false;connectionFailure=app.nikkisync.mobile.net.ConnectionFailure.from(error);
                    SupportDiagnostics.recordLibraryFailure(this,connectionFailure);
                    loadOfflineLibrary(current.server(),session);
                    android.util.Log.w("NikkiSync-Connection","Library unavailable: "+connectionFailure+" / "+error.getClass().getSimpleName());
                    connectionState.httpResult(session, false);
                    setBusy(false); renderConnectionStatus(); updateGalleryEmptyState();
                });
            }
        });
    }

    private void handleRealtime(String json) {
        try {
            JSONObject event = new JSONObject(json);
            long revision = event.optLong("revision", event.optLong("libraryRevision", 0));
            PairedServer server = serverStore.load();
            if (server != null && revision > server.lastRevision()) syncChanges();
        } catch (Exception ignored) {}
    }

    private void onConnectionAvailable(){
        // Inspiration is independent of the gallery snapshot, which can take time for large albums.
        syncInspirations(false);
        if(activeTab==TAB_SAVED)refreshSavedPhotos(true);
    }

    private void syncInspirations(boolean force){
        NikkiSyncClient current=client;
        if(current==null||!connectionForeground||!connectionState.isReachable()){
            inspirationMessage="灵感保存在手机本地，连接电脑后可同步。";
            if(inspirationPage!=null)inspirationPage.setSyncStatus(inspirationMessage);return;
        }
        if(inspirationRunning){if(force)inspirationAgain=true;return;}
        if(!force&&System.currentTimeMillis()-lastInspirationAttempt<45_000)return;
        lastInspirationAttempt=System.currentTimeMillis();inspirationRunning=true;long epoch=inspirationEpoch.get();
        inspirationMessage="正在同步灵感…";if(inspirationPage!=null)inspirationPage.setSyncStatus(inspirationMessage);
        inspirationIo.execute(()->{
            String result;
            try(var sync=new app.nikkisync.mobile.inspiration.InspirationSyncClient(this,current,()->inspirationEpoch.get()==epoch)){
                var outcome=sync.sync();
                result=outcome.failed()>0?"部分灵感未能同步，记录仍保存在原设备，请检查参考图并重试。":
                    outcome.conflicts()>0?"同步完成，已保留 "+outcome.conflicts()+" 份冲突副本。":"灵感已与电脑同步。";
            }catch(app.nikkisync.mobile.inspiration.InspirationSyncClient.UnsupportedServer unsupported){result="当前电脑端暂不支持灵感同步，手机本地记录仍保留。";}
            catch(Exception error){result="灵感暂未同步，记录仍保存在原设备，连接后会重试。";}
            String message=result;main.post(()->{
                inspirationRunning=false;boolean again=inspirationAgain;inspirationAgain=false;
                if(inspirationEpoch.get()==epoch){inspirationMessage=message;if(inspirationPage!=null){inspirationPage.setSyncStatus(message);inspirationPage.refreshAfterSync();}}
                if(again&&connectionForeground&&!isFinishing()&&!isDestroyed())syncInspirations(true);
            });
        });
    }

    private void renderConnectionStatus() {
        if(imageLoader!=null)imageLoader.setNetworkAvailable(connectionState.isReachable());
        refreshViewerConnections();
        if(libraryLoadedForSession&&connectionState.isReachable())maybeWarmOfflineCache();
        updateCacheWakeLock();
        if (connectionState.isRealtimeConnected()) setStatus("已连接 · 实时同步中");
        else if (connectionState.isReachable()) setStatus("已连接电脑 · 实时同步重连中，可手动刷新");
        else if(connectionFailure!=null&&connectionFailure.requiresPairing())setStatus(connectionFailure.message());
        else setStatus("离线整理 · 仅显示已缓存缩略图，删除将在重连后确认");
        if(status!=null){
            boolean needsHelp=!connectionState.isReachable();
            status.setOnClickListener(needsHelp?v->showTroubleshooting():null);
            status.setContentDescription(needsHelp?status.getText()+"。点按查看连接自查":status.getText());
        }
        if(connectionState.isReachable())connectionAdviceShownForSession=-1;
        else if(connectionFailure!=null&&pairedServer!=null&&connectionForeground&&!isFinishing()&&!isDestroyed()
                &&connectionAdviceShownForSession!=connectionState.session()){
            connectionAdviceShownForSession=connectionState.session();
            AdviceDialog.show(this,"电脑连接失败",
                    TroubleshootingAdvice.connection(true,false,connectionFailure,canDiscoverNearby()),
                    "知道了",null,"打开自查",this::showTroubleshooting);
        }
        if (activeTab == TAB_MY) refreshMyPage();
        refreshSettingsPage();
        refreshTroubleshooting();
        renderRemoteProfileStats();
        if(profileStatsContent!=null)loadRemoteProfileStats();
    }

    private void refreshViewerConnections(){
        for(Runnable refresh:new ArrayList<>(viewerConnections.values()))refresh.run();
    }

    private void probeConnection(long session) {
        probeConnection(session,null);
    }

    private void refreshKnownEndpoints(NikkiSyncClient current,long session){
        io.execute(()->{
            try{
                PairedServer verified=app.nikkisync.mobile.net.VerifiedEndpointResolver.inspect(current.server());
                main.post(()->{
                    if(!connectionState.isCurrent(session))return;
                    PairedServer latest=serverStore.load();
                    if(latest!=null&&latest.serverId().equals(verified.serverId())&&latest.tlsFingerprintSha256().equals(verified.tlsFingerprintSha256())){
                        PairedServer updated=latest.withHosts(verified.hosts());serverStore.save(updated);pairedServer=updated;
                    }
                });
            }catch(Exception ignored){}
        });
    }

    private void probeConnection(long session,PairedServer discovered) {
        NikkiSyncClient current = client;
        if (current == null || connectionProbePending || io.isShutdown()) return;
        connectionProbePending = true;
        PairedServer known=discovered==null?serverStore.load():discovered;
        if(known==null){connectionProbePending=false;return;}
        io.execute(() -> {
            boolean reachable;
            app.nikkisync.mobile.net.ConnectionFailure failure;
            PairedServer selected=null;
            try {
                selected=app.nikkisync.mobile.net.VerifiedEndpointResolver.resolve(known);
                new NikkiSyncClient(selected,identity).assets(null,1);
                reachable = true;failure=null;
            }
            catch (Exception error) { reachable = false;failure=app.nikkisync.mobile.net.ConnectionFailure.from(error); }
            boolean result = reachable;
            var finalFailure=failure;
            PairedServer verified=selected;
            main.post(() -> {
                if (!connectionState.isCurrent(session)) return;
                connectionProbePending = false;
                connectionFailure=finalFailure;
                if(result&&verified!=null){
                    PairedServer latest=serverStore.load();
                    if(latest==null||!latest.serverId().equals(verified.serverId())||!latest.tlsFingerprintSha256().equals(verified.tlsFingerprintSha256()))return;
                    PairedServer updated=latest.withEndpoint(verified.host(),verified.port()).withHosts(verified.hosts());
                    serverStore.save(updated);pairedServer=updated;
                    if(!current.server().host().equals(updated.host())||current.server().port()!=updated.port()){
                        connect(updated,"已自动找到可达地址 · 正在连接…");return;
                    }
                }
                connectionState.httpResult(session, result);
                renderConnectionStatus();
                if(result){
                    onConnectionAvailable();
                    if(!libraryLoadedForSession)loadLibrary("已重新连接 · 正在读取图库…");
                }
            });
        });
    }

    private void syncChanges() {
        // Realtime events can be missed while the socket reconnects. The foreground
        // heartbeat also checks the small change feed, but never queues behind an
        // in-progress full snapshot or adds another concurrent feed request.
        if(libraryLoading)return;
        if (!syncing.compareAndSet(false, true)) return;
        long session = connectionState.session();
        NikkiSyncClient current = client; PairedServer server = serverStore.load();
        if (current == null || server == null) { syncing.set(false); return; }
        io.execute(() -> {
            try {
                Changes changes = current.changes(server.lastRevision());
                main.post(() -> {
                    if (!connectionState.isCurrent(session)) return;
                    if (changes.fullResyncRequired() || !changes.items().isEmpty()) loadLibrary("发现新照片 · 正在同步…");
                    else serverStore.updateRevision(changes.libraryRevision());
                });
            } catch (Exception error) {
                main.post(()->{if(connectionState.isCurrent(session))probeConnection(session);});
            } finally { syncing.set(false); }
        });
    }

    private void saveSelected() {
        requestPhotoSave(adapter.selectedItems(), true);
    }

    private void requestPhotoSave(List<AssetSummary> requested,boolean clearSelection) {
        List<AssetSummary> selected=new ArrayList<>(requested);
        if(selected.stream().noneMatch(AssetSummary::hasMotion)){savePhotos(selected,clearSelection);return;}
        if(photoSaveProgress!=null&&photoSaveProgress.isShowing()){toast("正在保存，请等待完成");return;}
        LinearLayout choices=new LinearLayout(this);choices.setOrientation(LinearLayout.VERTICAL);
        Button live=button("实况照片"),video=button("视频"),cancel=button("取消");
        LinearLayout.LayoutParams liveLp=new LinearLayout.LayoutParams(-1,dp(52));liveLp.topMargin=dp(8);liveLp.bottomMargin=dp(12);
        LinearLayout.LayoutParams videoLp=new LinearLayout.LayoutParams(-1,dp(52));videoLp.bottomMargin=dp(8);
        choices.addView(live,liveLp);choices.addView(video,videoLp);
        TextView note=text("按当前旋转方向保存"+(selected.size()>1?"，普通照片仍保存为图片":""),13,false,getColor(R.color.text_secondary));
        note.setPadding(0,dp(8),0,dp(8));choices.addView(note);
        var sheet=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(this,
            text("保存为",20,true,getColor(R.color.text_primary)),choices,cancel).wrapContentForm();
        boolean[] chosen={false};
        java.util.function.Consumer<Boolean> choose=asVideo->{
            if(chosen[0])return;chosen[0]=true;navigation.dismiss(sheet);
            savePhotos(selected,clearSelection,asVideo);
        };
        live.setOnClickListener(v->choose.accept(false));video.setOnClickListener(v->choose.accept(true));
        cancel.setOnClickListener(v->{if(!chosen[0]){chosen[0]=true;navigation.dismiss(sheet);}});
        navigation.showSheet(sheet);
    }

    private void savePhotos(List<AssetSummary> requested, boolean clearSelection) {
        savePhotos(requested,clearSelection,false);
    }

    private void savePhotos(List<AssetSummary> requested, boolean clearSelection,boolean motionAsVideo) {
        List<AssetSummary> selected = new ArrayList<>(requested); NikkiSyncClient current = client;
        if (selected.isEmpty()) return;
        if(current==null){toast("请先连接电脑");return;}
        if(photoSaveProgress!=null&&photoSaveProgress.isShowing()){toast("正在保存，请等待完成");return;}
        var saving=new app.nikkisync.mobile.ui.OperationProgressDialog(this,"保存到相册",null);
        photoSaveProgress=saving;saving.update("准备保存 · 0 / "+selected.size()+" 张",0,0);saving.show();
        // Snapshot UI-owned choices before worker access; each photo keeps its own rotation.
        Map<String, Integer> rotationsSnapshot = new LinkedHashMap<>(rotationByAssetId);
        LivePhotoProfile liveProfile = LivePhotoControls.selectedProfile(this);
        setBusy(true); saveButton.setEnabled(false); setStatus("正在保存 0 / " + selected.size());
        io.execute(() -> {
            int success = 0; int failure = 0; boolean savedMotion = false;
            String firstFailure = null;
            List<AssetSummary> completed = new ArrayList<>();
            for (int i = 0; i < selected.size(); i++) {
                if (Thread.currentThread().isInterrupted()) {
                    failure += selected.size() - i;
                    if (firstFailure == null) firstFailure = "保存已取消";
                    break;
                }
                AssetSummary asset = selected.get(i);
                int index = i + 1; main.post(() -> setStatus("正在保存 " + index + " / " + selected.size()));
                main.post(()->saving.update("读取照片 · "+index+" / "+selected.size()+" 张",0,0));
                try {
                    Uri savedUri;
                    String savedFormat;
                    int savedRotation = rotationsSnapshot.getOrDefault(asset.assetId(), 0);
                    LivePhotoExporter.Result liveResult = null;

                    boolean standaloneVideo=asset.isVideo()||(asset.hasMotion()&&motionAsVideo);
                    if (standaloneVideo) {
                        savedUri=app.nikkisync.mobile.media.MotionVideoSaver.save(this,current,asset,savedRotation,
                            (stage,done,total)->main.post(()->saving.update("视频 "+index+" / "+selected.size()+" · "+stage,done,total)));
                        savedFormat=savedRotation==0?"原视频":"视频 · 已旋转 "+savedRotation+"°";
                    } else if (asset.hasMotion()) {
                        liveResult = LivePhotoExporter.save(this, current, asset, savedRotation, liveProfile,
                                (stage, percent) -> main.post(() -> {
                                    if (!isFinishing() && !isDestroyed())
                                        setStatus("LIVE " + index + " / " + selected.size() + " · " + stage + " " + percent + "%");
                                    saving.update("LIVE "+index+" / "+selected.size()+" · "+stage,percent,percent>0?100:0);
                                }));
                        savedUri = liveResult.primaryUri();
                        savedFormat = liveResult.savedFormat();
                    } else {
                        savedUri = originalSaver.save(this, current, asset, savedRotation,
                                (stage,done,total)->main.post(()->saving.update("照片 "+index+" / "+selected.size()+" · "+stage,done,total)));
                        savedFormat = savedRotation == 0 ? "原始照片" : "原始照片 · EXIF 旋转";
                    }

                    if (liveResult != null) {
                        savedPhotoStore.recordMotion(asset, savedUri, liveResult.companionUris(), savedRotation,
                                savedFormat, liveResult.profileId(), liveResult.presentationUs(), liveResult.timestampSource());
                    } else if (!standaloneVideo) {
                        savedPhotoStore.record(asset, savedUri, savedRotation, savedFormat);
                    }
                    if(!standaloneVideo)for(SavedPhotoStore.Record previous:savedPhotoStore.load()){
                        if(previous.assetId().equals(asset.assetId())&&!previous.uri().equals(savedUri.toString())
                                &&SavedPhotoVerifier.checkUri(this,previous.uri())==SavedPhotoHealthStore.State.MISSING){
                            savedPhotoStore.removeUri(previous.uri());savedPhotoHealthStore.remove(previous.uri());
                        }
                    }
                    try{if(savedSourceStore!=null)savedSourceStore.put(asset);}catch(Exception ignored){}
                    try {
                        AssetDetail savedDetail = current.asset(asset.assetId());
                        cacheMetadataSnapshot(asset.assetId(), asset.capturedAt(), asset.gameVersion(), savedDetail);
                    } catch (Exception ignored) {
                        // Saving the user's media succeeds independently from metadata-cache refresh.
                    }
                    success++;
                    savedMotion |= liveResult != null;
                    completed.add(asset);
                } catch (Exception error) {
                    failure++;
                    if (firstFailure == null) firstFailure = message(error);
                }
                main.post(()->saving.update("已处理照片",index,selected.size()));
            }
            int saved = success, failed = failure; boolean motion = savedMotion;
            String failureDetail = firstFailure;
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                saving.dismiss();if(photoSaveProgress==saving)photoSaveProgress=null;
                setBusy(false); saveButton.setEnabled(true);
                applyCompletedSaves(completed, rotationsSnapshot, clearSelection);
                updateSelection();
                refreshSavedPhotos();
                boolean videos=selected.stream().anyMatch(AssetSummary::isVideo);
                String result = "已保存 " + saved + " 项" + (motionAsVideo?"（动态照片保存为视频）":"") + (failed > 0 ? "，失败 " + failed + " 项" : "");
                if(videos&&saved>0)result+="。视频可在系统相册中查看";
                if (motion && saved > 0) result += "。LIVE 封装已写出，原生相册播放需确认";
                if (failureDetail != null) result += "。首个失败：" + failureDetail;
                toast(result); renderConnectionStatus();
            });
        });
    }

    private void applyCompletedSaves(List<AssetSummary> completed,Map<String,Integer> rotationsSnapshot,boolean clearSelection) {
        for (AssetSummary item : completed) {
            if (!rotationByAssetId.getOrDefault(item.assetId(), 0).equals(rotationsSnapshot.getOrDefault(item.assetId(), 0))) continue;
            // Export does not change the direction still displayed by the open viewer.
            if (clearSelection && adapter.isSelected(item)) adapter.toggle(item);
        }
    }

    private void showViewer(AssetSummary asset) {
        List<AssetSummary> context=adapter.visiblePhotos();
        if(context.stream().noneMatch(a->a.assetId().equals(asset.assetId())))context=List.of(asset);
        showViewer(asset,context);
    }
    private void showViewer(AssetSummary asset,List<AssetSummary> context){
        View sourceScope=navigation.getChildCount()>0?navigation.getChildAt(navigation.getChildCount()-1):galleryList;
        PhotoViewerPage dialog = new PhotoViewerPage(this, findThumbnail(sourceScope, asset.assetId() + ":"));
        showViewer(asset,dialog,context,sourceScope);
    }

    private void showViewer(AssetSummary asset,PhotoViewerPage dialog,List<AssetSummary> context,View sourceScope) {
        final String viewerScope=app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer);
        java.util.function.BooleanSupplier viewerOnline=()->connectionState.isReachable()
                &&viewerScope.equals(app.nikkisync.mobile.storage.OrganizerStore.scope(pairedServer));
        final boolean online=viewerOnline.getAsBoolean();
        cancelShareCardFrom(pendingShareCardButton);
        dialog.preparePhoto(findThumbnail(sourceScope,asset.assetId()+":"));
        int index=0;for(int i=0;i<context.size();i++)if(context.get(i).assetId().equals(asset.assetId())){index=i;break;}
        final int position=index;
        dialog.setPaging(index>0,index+1<context.size(),direction->showViewer(context.get(position+direction),dialog,context,sourceScope));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getColor(R.color.app_background));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(14), dp(12), dp(14), dp(24));
        scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout viewerHeader = new LinearLayout(this);
        viewerHeader.setGravity(Gravity.CENTER_VERTICAL);
        viewerHeader.setPadding(dp(4), 0, dp(2), dp(10));
        TextView viewerTitle = text((asset.isVideo()?"视频":asset.hasMotion() ? "LIVE 照片" : "照片")+(context.size()>1?" · "+(position+1)+" / "+context.size():""), 20, true, getColor(R.color.text_primary));
        viewerHeader.addView(viewerTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = button("完成");
        close.setOnClickListener(v -> dialog.dismiss());
        viewerHeader.addView(close);
        body.addView(viewerHeader);

        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setBackgroundResource(R.drawable.bg_gallery_photo);
        image.setClipToOutline(true);
        int previewSize = Math.max(dp(240), getResources().getDisplayMetrics().widthPixels - dp(28));
        body.addView(image, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, previewSize));
        if(!online)loadViewerPhoto(asset,image,false);

        int[] rotationHolder = new int[]{rotationByAssetId.getOrDefault(asset.assetId(), 0)};
        image.setRotation(rotationHolder[0]);
        if (!asset.hasMotion()) {
            LinearLayout rotationControls = new LinearLayout(this);
            rotationControls.setGravity(Gravity.CENTER_VERTICAL);
            rotationControls.setPadding(0, dp(10), 0, dp(8));
            Button rotateLeft = button("左转 90°");
            Button rotateRight = button("右转 90°");
            TextView rotationLabel = text(rotationLabel(rotationHolder[0]), 12, true, getColor(R.color.photo_detail_text));
            rotationLabel.setGravity(Gravity.CENTER);
            rotateLeft.setOnClickListener(v -> {
                rotationHolder[0] = normalizeRotation(rotationHolder[0] - 90);
                rememberRotation(asset.assetId(), rotationHolder[0]);
                image.setRotation(rotationHolder[0]);
                dialog.refreshImageTransform();
                rotationLabel.setText(rotationLabel(rotationHolder[0]));
            });
            rotateRight.setOnClickListener(v -> {
                rotationHolder[0] = normalizeRotation(rotationHolder[0] + 90);
                rememberRotation(asset.assetId(), rotationHolder[0]);
                image.setRotation(rotationHolder[0]);
                dialog.refreshImageTransform();
                rotationLabel.setText(rotationLabel(rotationHolder[0]));
            });
            rotationControls.addView(rotateLeft);
            rotationControls.addView(rotationLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            rotationControls.addView(rotateRight);
            dialog.addAction("旋转", rotateRight::performClick);
        } else {
            java.util.function.IntConsumer rotateLive = LivePhotoControls.attach(this, body, image, rotationHolder[0], degrees -> {
                rotationHolder[0] = degrees;
                rememberRotation(asset.assetId(), degrees);
                dialog.refreshImageTransform();
            });
            dialog.addAction("旋转", () -> rotateLive.accept(90));
        }

        LinearLayout infoSheet = new LinearLayout(this);
        infoSheet.setOrientation(LinearLayout.VERTICAL);
        infoSheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        infoSheet.setBackgroundResource(R.drawable.bg_photo_detail_glass_card);
        LinearLayout.LayoutParams sheetLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sheetLp.topMargin = dp(4);
        body.addView(infoSheet, sheetLp);

        String description = PlayerFacingDetails.sourcePhoto(asset);
        String offlineDescription="离线预览 · 当前为已缓存图片，保存、分享及 LIVE 播放需要连接电脑。\n"+description;
        TextView info = text(online?description:offlineDescription, 13, false, getColor(R.color.photo_detail_text_secondary));
        info.setPadding(dp(2), 0, dp(2), dp(10));
        info.setVisibility(online&&description.isEmpty() ? View.GONE : View.VISIBLE);
        infoSheet.addView(info);
        addSourceDetails(infoSheet,asset);

        LinearLayout clothingSection = new LinearLayout(this);
        clothingSection.setOrientation(LinearLayout.VERTICAL);
        clothingSection.setVisibility(View.GONE);
        clothingSection.setPadding(0, dp(6), 0, dp(8));
        infoSheet.addView(clothingSection);

        Button shareCard = button("生成分享图");
        shareCard.setEnabled(false);
        LinearLayout.LayoutParams shareLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        shareLp.topMargin = dp(8);
        if(!asset.isVideo())infoSheet.addView(shareCard, shareLp);

        AssetDetail[] detailHolder = new AssetDetail[1];
        if(!asset.isVideo())showMetadataNotice(clothingSection,online?"正在读取照片参数…":"尚未缓存这张照片的参数，连接电脑后可读取。");
        if(!asset.isVideo()&&!online){
            SavedMetadataSnapshotStore.Snapshot cached=savedMetadataSnapshotStore==null?null:savedMetadataSnapshotStore.get(asset.assetId());
            if(cached!=null)renderClothingSection(asset.assetId(),cached.metadataJson(),clothingSection,asset);
            else if(!asset.hasMetadata())renderClothingSection(asset.assetId(),null,clothingSection,asset);
        }
        shareCard.setOnClickListener(v -> {
            AssetDetail detail = detailHolder[0];
            NikkiSyncClient current = client;
            if(!viewerOnline.getAsBoolean()){toast("请先连接这张照片所属的电脑");return;}
            if (detail == null || current == null) {
                toast("照片参数尚未准备好");
                return;
            }
            confirmShareMetadata(PlayerFacingDetails.metadataNoticeForAsset(asset,detail.metadataJson()),
                    ()->exportRemoteShareCard(shareCard,current,asset,detail.metadataJson()));
        });

        Button select = button(adapter.isSelected(asset)?"✓ 已选择":"○ 选择照片");
        LinearLayout.LayoutParams selectLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        selectLp.topMargin = dp(8);
        select.setOnClickListener(v -> {
            adapter.toggle(asset);
            updateSelection();
            select.setText(adapter.isSelected(asset)?"✓ 已选择":"○ 选择照片");
        });
        infoSheet.addView(select, selectLp);
        Button pendingDelete=button("加入待删除");pendingDelete.setOnClickListener(v->queueDeletion(List.of(asset)));LinearLayout.LayoutParams pendingDeleteLp=new LinearLayout.LayoutParams(-1,-2);pendingDeleteLp.topMargin=dp(8);infoSheet.addView(pendingDelete,pendingDeleteLp);
        Button selection = button(adapter.isSelected(asset)?"✓":"○");
        stylePhotoSelection(selection,adapter.isSelected(asset));
        selection.setContentDescription(adapter.isSelected(asset)?"取消选择照片":"选择照片");
        selection.setOnClickListener(v->{adapter.toggle(asset);updateSelection();boolean selected=adapter.isSelected(asset);
            stylePhotoSelection(selection,selected);selection.setContentDescription(selected?"取消选择照片":"选择照片");select.setText(selected?"✓ 已选择":"○ 选择照片");});
        viewerHeader.addView(selection,0,new LinearLayout.LayoutParams(dp(48),dp(48)));
        dialog.addAction("保存", online, () -> {if(viewerOnline.getAsBoolean())requestPhotoSave(List.of(asset), false);});
        if(!asset.isVideo())dialog.addAction("分享", online, () -> { if (shareCard.isEnabled()) shareCard.performClick(); else toast("正在读取照片信息，请稍后"); });

        dialog.setContentView(scroll);
        // A viewer can open from the offline cache while a probe is still in flight.
        // Keep its controls and remote sources bound to the current verified session.
        Runnable refreshConnection=new Runnable(){
            private boolean available;
            private NikkiSyncClient loadedClient;
            private long loadedSession=Long.MIN_VALUE,generation;
            private boolean accepts(long request,long session,NikkiSyncClient requested){
                return viewerConnections.get(dialog)==this&&generation==request
                        &&connectionState.isCurrent(session)&&client==requested&&viewerOnline.getAsBoolean();
            }
            @Override public void run(){
                if(viewerConnections.get(dialog)!=this)return;
                boolean now=viewerOnline.getAsBoolean();
                dialog.setActionEnabled("保存",now);dialog.setActionEnabled("分享",now);
                info.setText(now?description:offlineDescription);
                info.setVisibility(now&&description.isEmpty()?View.GONE:View.VISIBLE);
                if(!now){
                    if(available){
                        generation++;loadedClient=null;loadedSession=Long.MIN_VALUE;
                        detailHolder[0]=null;shareCard.setEnabled(false);cancelShareCardFrom(shareCard);
                        dialog.clearLivePhoto();
                    }
                    available=false;return;
                }
                NikkiSyncClient current=client;long session=connectionState.session();
                if(available&&loadedClient==current&&loadedSession==session)return;
                available=true;loadedClient=current;loadedSession=session;long request=++generation;
                detailHolder[0]=null;shareCard.setEnabled(false);
                imageLoader.loadPreview(current,asset,image);
                if(asset.isVideo())dialog.setRemoteVideo(current,asset.assetId());
                else if(asset.hasMotion())dialog.setLivePhoto(app.nikkisync.mobile.media.live.MotionPreviewLoader.remote(MainActivity.this,current,asset.assetId()));
                if(asset.isVideo()||current==null||io.isShutdown())return;
                showMetadataNotice(clothingSection,"正在读取照片参数…");
                io.execute(()->{
                    try{
                        AssetDetail detail=current.asset(asset.assetId());
                        main.post(()->{
                            if(!accepts(request,session,current))return;
                            cacheMetadataSnapshot(asset.assetId(),asset.capturedAt(),asset.gameVersion(),detail);
                            detailHolder[0]=detail;renderClothingSection(asset,detail,clothingSection);shareCard.setEnabled(true);
                        });
                    }catch(Exception ignored){main.post(()->{
                        if(accepts(request,session,current)){
                            showMetadataNotice(clothingSection,"电脑暂时无法返回这张照片的参数，请稍后重试。");
                        }
                    });}
                });
            }
        };
        viewerConnections.put(dialog,refreshConnection);
        dialog.setOnDismissListener(()->{
            if(viewerConnections.get(dialog)==refreshConnection)viewerConnections.remove(dialog);
            cancelShareCardFrom(shareCard);
        });
        refreshConnection.run();
        dialog.setAdjacentPhotos(position>0?preloadRemotePhoto(context.get(position-1)):null,
                position+1<context.size()?preloadRemotePhoto(context.get(position+1)):null);
        dialog.show();
    }

    private void loadViewerPhoto(AssetSummary asset,ImageView image,boolean online){
        if(!online&&pairedServer!=null)imageLoader.loadOfflinePreview(pairedServer,asset,image);
        else imageLoader.loadPreview(client,asset,image);
    }
    private void stylePhotoSelection(Button button,boolean selected){
        button.setTag("photo-selection");
        button.setBackgroundTintList(null);
        button.setBackground(new android.graphics.drawable.InsetDrawable(getDrawable(R.drawable.photo_selection_mark),dp(7)));
        button.setActivated(selected);
        button.setPadding(0,0,0,0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setText("");
    }
    private AssetSummary savedSource(String id){AssetSummary source=findAsset(id);return source==null&&savedSourceStore!=null?savedSourceStore.get(id):source;}
    private void addSourceDetails(LinearLayout target,AssetSummary asset){
        if(asset==null)return;
        int ink=getColor(R.color.photo_detail_text_secondary);
        target.addView(text("所属 UID："+(asset.uid()==null||asset.uid().isBlank()?"未识别":asset.uid()),13,false,ink));
        if(asset.sourcePath()!=null&&!asset.sourcePath().isBlank()){
            TextView path=text("文件路径："+app.nikkisync.mobile.ui.PhotoScopeFilter.tail(asset.sourcePath()),13,false,ink);path.setBackground(roundRect(0x401d1920,14));path.setPadding(dp(10),dp(8),dp(10),dp(8));path.setContentDescription("点击展开并复制文件路径");
            boolean[] expanded={false};path.setOnClickListener(v->{expanded[0]=!expanded[0];path.setText("文件路径："+(expanded[0]?asset.sourcePath():app.nikkisync.mobile.ui.PhotoScopeFilter.tail(asset.sourcePath())));copyText("照片文件路径",asset.sourcePath());toast("已复制文件路径");});
            LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(6);lp.bottomMargin=dp(6);target.addView(path,lp);
        }else target.addView(text("文件路径：暂未记录，连接新版电脑端后更新",12,false,ink));
        String pixels=asset.width()!=null&&asset.height()!=null?asset.width()+" × "+asset.height():"";
        String size=asset.sizeBytes()==null?"":String.format(java.util.Locale.ROOT,"%.2f MB",asset.sizeBytes()/1000000d);
        if(!pixels.isEmpty()||!size.isEmpty())target.addView(text("图片大小："+pixels+(pixels.isEmpty()||size.isEmpty()?"":" · ")+size,13,false,ink));
    }
    private ImageView preloadRemotePhoto(AssetSummary asset){
        ImageView photo=new ImageView(this);photo.setRotation(rotationByAssetId.getOrDefault(asset.assetId(),0));loadViewerPhoto(asset,photo,connectionState.isReachable());return photo;
    }
    private void preloadSavedNeighbors(PhotoViewerPage dialog,String uri,List<SavedPhotoGroups.Member> context){
        int index=-1;for(int i=0;i<context.size();i++)if(context.get(i).uri().equals(uri)){index=i;break;}
        dialog.setAdjacentPhotos(index>0?preloadSavedPhoto(context.get(index-1).uri()):null,
            index>=0&&index+1<context.size()?preloadSavedPhoto(context.get(index+1).uri()):null);
    }
    private ImageView preloadSavedPhoto(String uri){
        ImageView photo=new ImageView(this);io.execute(()->{try{
            android.graphics.Bitmap bitmap=app.nikkisync.mobile.media.SavedPhotoDecoder.decode(this,Uri.parse(uri),2048);
            main.post(()->photo.setImageBitmap(bitmap));
        }catch(Exception ignored){}});return photo;
    }

    private void configureSavedViewer(PhotoViewerPage dialog,String uri,List<SavedPhotoGroups.Member> context){
        dialog.preparePhoto(findThumbnail(savedList,uri));int found=-1;
        for(int i=0;i<context.size();i++)if(context.get(i).uri().equals(uri)){found=i;break;}
        final int index=found;
        dialog.setPaging(index>0,index>=0&&index+1<context.size(),direction->{
            SavedPhotoGroups.Member item=context.get(index+direction);
            if(item.kind()==SavedPhotoGroups.MemberKind.ORIGINAL)showSavedPhotoDetails(item.original(),dialog,context);
            else showEditedPhotoDetails(item.edited(),dialog,context);
        });
    }
    private ImageView findThumbnail(View view, String key) {
        if (view instanceof ImageView image) {
            if (key.endsWith(":") && key.substring(0,key.length()-1).equals(image.getTag(R.id.photo_source_asset_id))) return image;
            if (!key.endsWith(":") && key.equals(image.getTag())) return image; // Saved/edited content URI.
        }
        if (view instanceof ViewGroup group) for (int i=0;i<group.getChildCount();i++) {
            ImageView found=findThumbnail(group.getChildAt(i),key);if(found!=null)return found;
        }
        return null;
    }

    private void rememberRotation(String assetId, int rotationDegrees) {
        if (rotationDegrees == 0) rotationByAssetId.remove(assetId);
        else rotationByAssetId.put(assetId, rotationDegrees);
    }

    private static int normalizeRotation(int rotationDegrees) {
        return ((rotationDegrees % 360) + 360) % 360;
    }

    private static String rotationLabel(int rotationDegrees) {
        return rotationDegrees == 0 ? "原方向" : "旋转 " + rotationDegrees + "°";
    }

    private void renderClothingSection(AssetSummary asset, AssetDetail detail, LinearLayout section) {
        renderClothingSection(asset.assetId(),detail.metadataJson(),section,asset);
    }

    private void showMetadataNotice(LinearLayout section,String message) {
        section.removeAllViews();section.setVisibility(message.isBlank()?View.GONE:View.VISIBLE);
        if(message.isBlank())return;
        TextView notice=text(message,13,false,getColor(R.color.photo_detail_text));
        notice.setPadding(dp(12),dp(11),dp(12),dp(11));notice.setBackground(roundRect(0x501d1920,14));
        section.addView(notice,new LinearLayout.LayoutParams(-1,-2));
    }

    private void renderClothingSection(String assetId, String metadataJson, LinearLayout section) {
        renderClothingSection(assetId,metadataJson,section,savedSource(assetId));
    }

    private void renderClothingSection(String assetId, String metadataJson, LinearLayout section,AssetSummary source) {
        renderClothingSection(assetId,metadataJson,section,source,false);
    }

    private void renderClothingSection(String assetId, String metadataJson, LinearLayout section,AssetSummary source,boolean savedLive) {
        String notice=PlayerFacingDetails.metadataNoticeForAsset(source,metadataJson,savedLive);
        showMetadataNotice(section,notice);
        if (metadataJson == null) return;
        try {
            JSONObject metadata = new JSONObject(metadataJson);
            JSONObject dressing = metadata.optJSONObject("dressing");
            JSONArray clothes = dressing == null ? null : dressing.optJSONArray("clothes");
            if (clothes == null || clothes.length() == 0) return;
            JSONObject raw = metadata.optJSONObject("raw");
            JSONObject dictionary = raw == null ? null : raw.optJSONObject("dictionary");
            String cacheVersion = dictionary == null ? "" : dictionary.optString("providerVersion", "");

            int displayCount = 0;
            for (int i = 0; i < clothes.length(); i++) {
                JSONObject clothing = clothes.optJSONObject(i);
                if (clothing != null && clothing.has("id") && !clothing.isNull("id")) displayCount++;
            }
            if (displayCount == 0) return;

            TextView heading = text("穿搭 · " + displayCount + " 件", 16, true, getColor(R.color.photo_detail_text));
            heading.setPadding(dp(4), dp(6), dp(4), dp(8)); section.addView(heading);

            for (int i = 0; i < clothes.length(); i++) {
                JSONObject clothing = clothes.optJSONObject(i);
                if (clothing == null || !clothing.has("id") || clothing.isNull("id")) continue;
                String id = String.valueOf(clothing.opt("id")).trim();
                if (id.isEmpty()) continue;
                String name = clothing.optString("name", "").trim();
                name = PlayerFacingDetails.clothingName(name, id);
                String category = clothing.optString("category", "").trim();
                String categoryLabel = clothingCategoryLabel(category);

                LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(10), dp(8), dp(10), dp(8));
                row.setBackground(roundRect(0xFFF7F5F3, 14));
                LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rowLp.setMargins(0, 0, 0, dp(7));

                ImageView icon = new ImageView(this); icon.setScaleType(ImageView.ScaleType.FIT_CENTER); icon.setBackground(roundRect(0xFFECE8E4, 10));
                row.addView(icon, new LinearLayout.LayoutParams(dp(64), dp(64)));
                imageLoader.loadClothingThumbnail(connectionState.isReachable()?client:null, pairedServer, assetId, id, cacheVersion, icon);

                LinearLayout labels = new LinearLayout(this); labels.setOrientation(LinearLayout.VERTICAL); labels.setPadding(dp(10), 0, 0, 0);
                TextView nameView = text(name, 14, true, getColor(R.color.text_primary)); labels.addView(nameView);
                if (!category.isEmpty() && !categoryLabel.equals(category)) {
                    TextView categoryView = text(categoryLabel, 11, false, getColor(R.color.text_secondary));
                    categoryView.setPadding(0, dp(3), 0, 0);
                    labels.addView(categoryView);
                }
                row.addView(labels, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                section.addView(row, rowLp);
            }
            section.setVisibility(View.VISIBLE);
        } catch (Exception ignored) {
            showMetadataNotice(section,"照片参数暂不可用，请连接电脑重新同步。");
        }
    }

    private static String clothingCategoryLabel(String category) {
        return switch (category) {
            case "hair" -> "发型";
            case "dresses" -> "连衣裙";
            case "outerwear" -> "外套";
            case "tops" -> "上衣";
            case "bottoms" -> "下装";
            case "socks" -> "袜子";
            case "shoes" -> "鞋子";
            case "hairAccessories" -> "发饰";
            case "headwear" -> "帽子";
            case "earrings" -> "耳饰";
            case "neckwear" -> "颈饰";
            case "bracelets" -> "腕饰";
            case "chokers" -> "项圈";
            case "gloves" -> "手套";
            case "faceDecorations" -> "面饰";
            case "chestAccessories" -> "胸饰";
            case "pendants" -> "挂饰";
            case "backpieces" -> "背饰";
            case "rings" -> "戒指";
            case "armDecorations" -> "臂饰";
            case "handhelds" -> "手持物";
            case "bodyPaint" -> "肤绘";
            case "fullMakeup" -> "全妆";
            case "baseMakeup" -> "底妆";
            case "eyebrows" -> "眉妆";
            case "eyelashes" -> "睫毛";
            case "contacts" -> "美瞳";
            case "lips" -> "唇妆";
            case "skinTones" -> "肤色";
            default -> category.isEmpty() ? "未知部位" : category;
        };
    }

    private void updateSelection() {
        if (selectionBar == null || adapter == null) return;
        if(homeTabs!=null)homeTabs.setSelectionActive(activeTab==TAB_GALLERY&&adapter.hasSelection());
        int count = adapter.selectedCount();
        selectionBar.setVisibility(activeTab == TAB_GALLERY && count > 0 ? View.VISIBLE : View.GONE);
        selectionLabel.setText("已选择 " + count + " 张"); saveButton.setText("保存原图");
    }

    private void requestNearbyAndDiscover() {
        if(!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()||discovery==null)return;
        if (canDiscoverNearby()) discovery.start();
        else requestPermissions(new String[]{Manifest.permission.NEARBY_WIFI_DEVICES}, NEARBY_PERMISSION);
    }

    private boolean canDiscoverNearby() {
        // NSD on Android 11/12 does not use the Android 13 nearby-Wi-Fi runtime permission.
        return android.os.Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if(requestCode==UPDATE_NOTIFICATION_PERMISSION&&!BuildConfig.STORE_SUBMISSION){
            if(grantResults.length>0&&grantResults[0]==PackageManager.PERMISSION_GRANTED)enableAppUpdateNotifications();
            else if(appUpdatePanel!=null)appUpdatePanel.notificationResult("已保留手动检查，可随时开启提醒。");
        }
        if (requestCode == NEARBY_PERMISSION && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                &&discovery!=null&&new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()) discovery.start();
    }

    @Override public void onEndpoint(String serverId, String host, int port) {
        main.post(() -> {
            if(!connectionForeground||isFinishing()||serverStore==null||!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted())return;
            PairedServer current = serverStore.load();
            android.util.Log.i("NikkiSync-Connection","Discovery identity matches saved pairing: "+(current!=null&&current.serverId().equals(serverId)));
            if (current == null || !current.serverId().equals(serverId)) return;
            if(connectionState.isReachable()||connectionProbePending)return;
            probeConnection(connectionState.session(),current.withEndpoint(host,port));
        });
    }

    @Override public void onDiscoveryState(boolean active) {}

    private void realtimeStop() { if (realtime != null) realtime.stop(); realtime = null; }
    private void setBusy(boolean busy) { progress.setVisibility(busy ? View.VISIBLE : View.GONE); }
    private void setStatus(String value) { status.setText(value); }
    private void updatePairButton() { pairButton.setText(pairedServer == null ? "配对" : "电脑"); }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
    private static String message(Throwable error) { return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(sp); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD); return view;
    }

    private Button button(String value) {
        Button button = new Button(this,null,0); button.setStateListAnimator(null);button.setGravity(Gravity.CENTER);button.setText(value); button.setTextSize(12); button.setAllCaps(false);
        button.setTextColor(getColor(R.color.text_primary)); button.setBackground(roundRect(0xE8FFFFFF, 16));
        button.setPadding(dp(12), 0, dp(12), 0);button.setMinWidth(dp(88));button.setMinimumWidth(dp(88)); button.setMinHeight(dp(38)); button.setMinimumHeight(dp(38));
        return button;
    }

    private GradientDrawable roundRect(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), 0x1A000000); return drawable;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
