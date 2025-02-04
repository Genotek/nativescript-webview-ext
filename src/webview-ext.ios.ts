/// <reference path="./types/ios/NotaWebViewExt.d.ts" />

import "@nativescript/core";
import { alert, confirm, File, knownFolders, profile, prompt, Trace } from "@nativescript/core";
import { isEnabledProperty } from "@nativescript/core/ui/core/view";
import { webViewBridge } from "./nativescript-webview-bridge-loader";
import {
    autoInjectJSBridgeProperty,
    limitsNavigationsToAppBoundDomainsProperty,
    NavigationType,
    scrollBounceProperty,
    ViewPortProperties,
    viewPortProperty, WebViewExtBase
} from "./webview-ext-common";

export * from "./webview-ext-common";

const messageHandlerName = "nsBridge";

export class WebViewExt extends WebViewExtBase {
    public ios: WKWebView;

    public static supportXLocalScheme = typeof CustomUrlSchemeHandler !== "undefined";

    protected wkWebViewConfiguration: WKWebViewConfiguration;
    protected wkNavigationDelegate: WKNavigationDelegateNotaImpl;
    protected wkUIDelegate: WKUIDelegateNotaImpl;
    protected wkCustomUrlSchemeHandler: CustomUrlSchemeHandler | void;
    protected wkUserContentController: WKUserContentController;
    protected wkUserScriptInjectWebViewBridge?: WKUserScript;
    protected wkUserScriptViewPortCode: Promise<WKUserScript | null> | null;
    protected wkNamedUserScripts = [] as Array<{
        resourceName: string;
        wkUserScript: WKUserScript;
    }>;

    public readonly supportXLocalScheme = typeof CustomUrlSchemeHandler !== "undefined";

    public viewPortSize = { initialScale: 1.0 };
    private limitsNavigationsToAppBoundDomains = false;

    public createNativeView() {
        const configuration = WKWebViewConfiguration.new();
        configuration.dataDetectorTypes = WKDataDetectorTypes.All;
        this.wkWebViewConfiguration = configuration;

        const messageHandler = WKScriptMessageHandlerNotaImpl.initWithOwner(new WeakRef(this));
        const wkUController = (this.wkUserContentController = WKUserContentController.new());
        wkUController.addScriptMessageHandlerName(messageHandler, messageHandlerName);
        configuration.userContentController = wkUController;
        configuration.preferences.setValueForKey(true, "allowFileAccessFromFileURLs");
        configuration.setValueForKey(true, "allowUniversalAccessFromFileURLs");
        configuration.limitsNavigationsToAppBoundDomains = this.limitsNavigationsToAppBoundDomains;
        if (this.supportXLocalScheme) {
            this.wkCustomUrlSchemeHandler = new CustomUrlSchemeHandler();
            configuration.setURLSchemeHandlerForURLScheme(this.wkCustomUrlSchemeHandler, this.interceptScheme);
        }

        const webview = new WKWebView({
            frame: CGRectZero,
            configuration,
        });

        return webview;
    }

    public initNativeView() {
        super.initNativeView();

        this.wkNavigationDelegate = WKNavigationDelegateNotaImpl.initWithOwner(new WeakRef(this));
        this.wkUIDelegate = WKUIDelegateNotaImpl.initWithOwner(new WeakRef(this));

        this.loadWKUserScripts();
    }

    public disposeNativeView() {
        this.wkWebViewConfiguration?.userContentController?.removeScriptMessageHandlerForName(messageHandlerName);
        this.wkWebViewConfiguration = null!;
        this.wkNavigationDelegate = null!;
        this.wkCustomUrlSchemeHandler = null!;
        this.wkUIDelegate = null!;

        super.disposeNativeView();
    }

    protected injectWebViewBridge() {
        return this.ensurePolyfills();
    }

    protected async injectViewPortMeta() {
        this.resetViewPortCode();
        if (this.supportXLocalScheme) {
            return;
        }

        return await super.injectViewPortMeta();
    }

    public async executeJavaScript<T>(scriptCode: string, stringifyResult = true): Promise<T> {
        if (stringifyResult) {
            scriptCode = `
                (function(window) {
                    var result = null;

                    try {
                        result = ${scriptCode.trim()};
                    } catch (err) {
                        return JSON.stringify({
                            error: true,
                            message: err.message,
                            stack: err.stack
                        });
                    }

                    try {
                        return JSON.stringify(result);
                    } catch (err) {
                        return result;
                    }
                })(window);
            `;
        }

        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return Promise.reject(new Error("WebView is missing"));
        }

        const rawResult = await new Promise<any>((resolve, reject) => {
            nativeView.evaluateJavaScriptCompletionHandler(scriptCode.trim(), (result, error) => {
                if (error) {
                    reject(error);

                    return;
                }

                resolve(result);
            });
        });

        const result: T = await this.parseWebViewJavascriptResult(rawResult);

        const r = result as any;
        if (r && typeof r === "object" && r.error) {
            const error = new Error(r.message);
            (error as any).webStack = r.stack;
            throw error;
        }

        return result;
    }

    @profile
    public onLoaded() {
        super.onLoaded();

        const nativeView = this.nativeViewProtected;
        if (nativeView) {
            nativeView.navigationDelegate = this.wkNavigationDelegate;
            nativeView.UIDelegate = this.wkUIDelegate;
        }
    }

    public onUnloaded() {
        const nativeView = this.nativeViewProtected;
        if (nativeView) {
            nativeView.navigationDelegate = null!;
            nativeView.UIDelegate = null!;
        }

        super.onUnloaded();
    }

    public stopLoading() {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.stopLoading();
    }

    public _loadUrl(src: string) {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        const nsURL = NSURL.URLWithString(src);
        if (src.startsWith("file:///")) {
            const cachePath = src.substring(0, src.lastIndexOf("/"));
            const nsReadAccessUrl = NSURL.URLWithString(cachePath);
            this.writeTrace(`WKWebViewWrapper.loadUrl("${src}") -> ios.loadFileURLAllowingReadAccessToURL("${nsURL}", "${nsReadAccessUrl}"`);
            nativeView.loadFileURLAllowingReadAccessToURL(nsURL, nsReadAccessUrl);
        } else {
            const nsRequestWithUrl = NSURLRequest.requestWithURL(nsURL);
            this.writeTrace(`WKWebViewWrapper.loadUrl("${src}") -> ios.loadRequest("${nsRequestWithUrl}"`);
            nativeView.loadRequest(nsRequestWithUrl);
        }
    }

    public _loadData(content: string) {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        const baseUrl = `file:///${knownFolders.currentApp().path}/`;
        const nsBaseUrl = NSURL.URLWithString(baseUrl);

        this.writeTrace(`WKWebViewWrapper.loadUrl(content) -> this.ios.loadHTMLStringBaseURL("${nsBaseUrl}")`);
        nativeView.loadHTMLStringBaseURL(content, nsBaseUrl);
    }

    public get canGoBack(): boolean {
        const nativeView = this.nativeViewProtected;

        return nativeView && !!nativeView.canGoBack;
    }

    public get canGoForward(): boolean {
        const nativeView = this.nativeViewProtected;

        return nativeView && !!nativeView.canGoForward;
    }

    public goBack() {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.goBack();
    }

    public goForward() {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.goForward();
    }

    public reload() {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.reload();
    }

    public _webAlert(message: string, callback: () => void) {
        if (!super._webAlert(message, callback)) {
            alert(message)
                .then(() => callback())
                .catch(() => callback());
        }

        return true;
    }

    public _webConfirm(message: string, callback: (response: boolean | null) => void) {
        if (!super._webConfirm(message, callback)) {
            confirm(message)
                .then((res) => callback(res))
                .catch(() => callback(null));
        }

        return true;
    }

    public _webPrompt(message: string, defaultText: string, callback: (response: string | null) => void) {
        if (!super._webPrompt(message, defaultText, callback)) {
            prompt(message, defaultText)
                .then((res) => {
                    if (res.result) {
                        callback(res.text);
                    } else {
                        callback(null);
                    }
                })
                .catch(() => callback(null));
        }

        return true;
    }

    public registerLocalResource(resourceName: string, path: string) {
        const cls = `WebViewExt<${this}.ios>.registerLocalResource("${resourceName}", "${path}")`;

        if (!this.supportXLocalScheme) {
            this.writeTrace(`${cls} -> custom schema isn't support on iOS <11`, Trace.messageType.error);

            return;
        }

        resourceName = this.fixLocalResourceName(resourceName);

        const filepath = this.resolveLocalResourceFilePath(path);
        if (!filepath) {
            this.writeTrace(`${cls} -> file doesn't exist`, Trace.messageType.error);

            return;
        }

        this.writeTrace(`${cls} -> file: "${filepath}"`);

        this.registerLocalResourceForNative(resourceName, filepath);
    }

    public unregisterLocalResource(resourceName: string) {
        const cls = `WebViewExt<${this}.ios>.unregisterLocalResource("${resourceName}")`;
        if (!this.supportXLocalScheme) {
            this.writeTrace(`${cls} -> custom schema isn't support on iOS <11`, Trace.messageType.error);

            return;
        }

        this.writeTrace(cls);

        resourceName = this.fixLocalResourceName(resourceName);

        this.unregisterLocalResourceForNative(resourceName);
    }

    public getRegisteredLocalResource(resourceName: string) {
        resourceName = this.fixLocalResourceName(resourceName);
        const cls = `WebViewExt<${this}.ios>.getRegisteredLocalResource("${resourceName}")`;
        if (!this.supportXLocalScheme) {
            this.writeTrace(`${cls} -> custom schema isn't support on iOS <11`, Trace.messageType.error);

            return;
        }

        let result = this.getRegisteredLocalResourceFromNative(resourceName);

        this.writeTrace(`${cls} -> "${result}"`);

        return result;
    }

    public getTitle() {
        return this.executeJavaScript<string>("document.title");
    }

    public async autoLoadStyleSheetFile(resourceName: string, path: string, insertBefore?: boolean) {
        const filepath = this.resolveLocalResourceFilePath(path);
        if (!filepath) {
            this.writeTrace(`WKWebViewWrapper.autoLoadStyleSheetFile("${resourceName}", "${path}") - couldn't resolve filepath`);

            return;
        }

        resourceName = this.fixLocalResourceName(resourceName);
        const scriptCode = await this.generateLoadCSSFileScriptCode(resourceName, filepath, insertBefore);

        if (scriptCode) {
            this.addNamedWKUserScript(`auto-load-css-${resourceName}`, scriptCode);
        }
    }

    public removeAutoLoadStyleSheetFile(resourceName: string) {
        resourceName = this.fixLocalResourceName(resourceName);
        this.removeNamedWKUserScript(`auto-load-css-${resourceName}`);
    }

    public async autoLoadJavaScriptFile(resourceName: string, path: string) {
        const filepath = this.resolveLocalResourceFilePath(path);
        if (!filepath) {
            this.writeTrace(`WKWebViewWrapper.autoLoadJavaScriptFile("${resourceName}", "${path}") - couldn't resolve filepath`);

            return;
        }

        const scriptCode = await File.fromPath(filepath).readText();

        this.addNamedWKUserScript(resourceName, scriptCode);
    }

    public removeAutoLoadJavaScriptFile(resourceName: string) {
        const fixedResourceName = this.fixLocalResourceName(resourceName);
        const href = `${this.interceptScheme}://${fixedResourceName}`;
        this.removeNamedWKUserScript(href);
    }

    [autoInjectJSBridgeProperty.setNative](enabled: boolean) {
        this.loadWKUserScripts(enabled);
    }

    [scrollBounceProperty.getDefault]() {

        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return false;
        }
        return nativeView.scrollView.bounces;
    }

    [scrollBounceProperty.setNative](enabled: boolean) {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.scrollView.bounces = !!enabled;
    }

    [viewPortProperty.setNative](value: ViewPortProperties) {
        if (this.src) {
            this.injectViewPortMeta();
        }
    }

    [limitsNavigationsToAppBoundDomainsProperty.setNative](enabled: boolean) {
        this.limitsNavigationsToAppBoundDomains = enabled;
    }

    [limitsNavigationsToAppBoundDomainsProperty.getDefault]() {
        return false;
    }

    [isEnabledProperty.setNative](enabled: boolean) {
        const nativeView = this.nativeViewProtected;
        if (!nativeView) {
            return;
        }

        nativeView.userInteractionEnabled = !!enabled;
        nativeView.scrollView.userInteractionEnabled = !!enabled;
    }

    /**
     * iOS11+
     *
     * Sets up loading WKUserScripts
     *
     * @param autoInjectJSBridge If true viewport-code, bridge-code and named scripts will be loaded, if false only viewport-code
     */
    protected loadWKUserScripts(autoInjectJSBridge = this.autoInjectJSBridge) {
        if (!this.wkUserScriptViewPortCode) {
            this.wkUserScriptViewPortCode = this.makeWKUserScriptPromise(this.generateViewPortCode());
        }

        this.wkUserContentController.removeAllUserScripts();

        this.addUserScriptFromPromise(this.wkUserScriptViewPortCode!);
        if (!autoInjectJSBridge) {
            return;
        }

        if (!this.wkUserScriptInjectWebViewBridge) {
            this.wkUserScriptInjectWebViewBridge = this.createWkUserScript(webViewBridge);
        }

        this.addUserScript(this.wkUserScriptInjectWebViewBridge);
        for (const { wkUserScript } of this.wkNamedUserScripts) {
            this.addUserScript(wkUserScript);
        }
    }

    /**
     * iOS11+
     *
     * Remove a named WKUserScript
     */
    protected removeNamedWKUserScript(resourceName: string) {
        const idx = this.wkNamedUserScripts.findIndex((val) => val.resourceName === resourceName);
        if (idx === -1) {
            return;
        }

        this.wkNamedUserScripts.splice(idx, 1);

        this.loadWKUserScripts();
    }

    protected async resetViewPortCode() {
        this.wkUserScriptViewPortCode = null;

        const viewPortScriptCode = await this.generateViewPortCode();
        if (viewPortScriptCode) {
            this.executeJavaScript(viewPortScriptCode);
            this.loadWKUserScripts();
        }
    }

    protected registerLocalResourceForNative(resourceName: string, filepath: string) {
        if (!this.wkCustomUrlSchemeHandler) {
            return;
        }

        this.wkCustomUrlSchemeHandler.registerLocalResourceForKeyFilepath(resourceName, filepath);
    }

    protected unregisterLocalResourceForNative(resourceName: string) {
        if (!this.wkCustomUrlSchemeHandler) {
            return;
        }

        this.wkCustomUrlSchemeHandler.unregisterLocalResourceForKey(resourceName);
    }

    protected getRegisteredLocalResourceFromNative(resourceName: string) {
        if (!this.wkCustomUrlSchemeHandler) {
            return;
        }

        return this.wkCustomUrlSchemeHandler.getRegisteredLocalResourceForKey(resourceName);
    }

    protected async makeWKUserScriptPromise(scriptCodePromise: Promise<string | null>): Promise<WKUserScript | null> {
        const scriptCode = await scriptCodePromise;
        if (!scriptCode) {
            return null;
        }

        return this.createWkUserScript(scriptCode);
    }

    protected async addUserScriptFromPromise(userScriptPromise: Promise<WKUserScript | null>) {
        const userScript = await userScriptPromise;
        if (!userScript) {
            return;
        }

        return this.addUserScript(userScript);
    }

    protected addUserScript(userScript: WKUserScript | null) {
        if (!userScript) {
            return;
        }

        this.wkUserContentController.addUserScript(userScript);
    }

    /**
     * iOS11+
     *
     * Add/replace a named WKUserScript.
     * These scripts will be injected when a new document is loaded.
     */
    protected addNamedWKUserScript(resourceName: string, scriptCode: string) {
        if (!scriptCode) {
            return;
        }

        this.removeNamedWKUserScript(resourceName);

        const wkUserScript = this.createWkUserScript(scriptCode);

        this.wkNamedUserScripts.push({ resourceName, wkUserScript });

        this.addUserScript(wkUserScript);
    }

    /**
     * iOS11+
     *
     * Factory function for creating a WKUserScript instance.
     */
    protected createWkUserScript(source: string) {
        return WKUserScript.alloc().initWithSourceInjectionTimeForMainFrameOnly(source, WKUserScriptInjectionTime.AtDocumentEnd, true);
    }
}

@NativeClass()
export class WKNavigationDelegateNotaImpl extends NSObject implements WKNavigationDelegate {
    public static ObjCProtocols = [WKNavigationDelegate];
    public static initWithOwner(owner: WeakRef<WebViewExt>): WKNavigationDelegateNotaImpl {
        const handler = <WKNavigationDelegateNotaImpl>WKNavigationDelegateNotaImpl.new();
        handler.owner = owner;

        return handler;
    }

    private owner: WeakRef<WebViewExt>;

    public webViewDecidePolicyForNavigationActionDecisionHandler(
        webView: WKWebView,
        navigationAction: WKNavigationAction,
        decisionHandler: (policy: WKNavigationActionPolicy) => void,
    ): void {
        const owner = this.owner.get();
        if (!owner) {
            decisionHandler(WKNavigationActionPolicy.Cancel);

            return;
        }

        const request = navigationAction.request;
        const httpMethod = request.HTTPMethod;
        const url = request.URL && request.URL.absoluteString;

        owner.writeTrace(`webViewDecidePolicyForNavigationActionDecisionHandler: "${url}"`);
        if (!url) {
            return;
        }

        let navType: NavigationType = "other";

        switch (navigationAction.navigationType) {
            case WKNavigationType.LinkActivated: {
                navType = "linkClicked";
                break;
            }
            case WKNavigationType.FormSubmitted: {
                navType = "formSubmitted";
                break;
            }
            case WKNavigationType.BackForward: {
                navType = "backForward";
                break;
            }
            case WKNavigationType.Reload: {
                navType = "reload";
                break;
            }
            case WKNavigationType.FormResubmitted: {
                navType = "formResubmitted";
                break;
            }
            default: {
                navType = "other";
                break;
            }
        }

        const shouldOverrideUrlLoading = owner._onShouldOverrideUrlLoading(url, httpMethod, navType);
        if (shouldOverrideUrlLoading === true) {
            owner.writeTrace(
                `WKNavigationDelegateClass.webViewDecidePolicyForNavigationActionDecisionHandler("${url}", "${navigationAction.navigationType}") -> method:${httpMethod} "${navType}" -> cancel`,
            );
            decisionHandler(WKNavigationActionPolicy.Cancel);

            return;
        }
        decisionHandler(WKNavigationActionPolicy.Allow);

        owner.writeTrace(
            `WKNavigationDelegateClass.webViewDecidePolicyForNavigationActionDecisionHandler("${url}", "${navigationAction.navigationType}") -> method:${httpMethod} "${navType}"`,
        );
        owner._onLoadStarted(url, navType);
    }

    public webViewDidStartProvisionalNavigation(webView: WKWebView, navigation: WKNavigation): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        owner.writeTrace(`WKNavigationDelegateClass.webViewDidStartProvisionalNavigation("${webView.URL}")`);
    }

    public webViewDidFinishNavigation(webView: WKWebView, navigation: WKNavigation): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        owner.writeTrace(`WKNavigationDelegateClass.webViewDidFinishNavigation("${webView.URL}")`);
        let src = owner.src;
        if (webView.URL) {
            src = webView.URL.absoluteString;
        }
        owner._onLoadFinished(src).catch(() => void 0);
    }

    public webViewDidFailNavigationWithError(webView: WKWebView, navigation: WKNavigation, error: NSError): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        let src = owner.src;
        if (webView.URL) {
            src = webView.URL.absoluteString;
        }
        owner.writeTrace(`WKNavigationDelegateClass.webViewDidFailNavigationWithError("${error.localizedDescription}")`);
        owner._onLoadFinished(src, error.localizedDescription).catch(() => void 0);
    }

    public webViewDidFailProvisionalNavigationWithError(webView: WKWebView, navigation: WKNavigation, error: NSError): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        let src = owner.src;
        if (webView.URL && webView.URL.absoluteString) {
            src = webView.URL.absoluteString;
        }

        owner.writeTrace(`WKNavigationDelegateClass.webViewDidFailProvisionalNavigationWithError(${error.localizedDescription}`);
        owner._onLoadFinished(src, error.localizedDescription).catch(() => void 0);
    }
}

@NativeClass()
export class WKScriptMessageHandlerNotaImpl extends NSObject implements WKScriptMessageHandler {
    public static ObjCProtocols = [WKScriptMessageHandler];

    private owner: WeakRef<WebViewExtBase>;

    public static initWithOwner(owner: WeakRef<WebViewExtBase>): WKScriptMessageHandlerNotaImpl {
        const delegate = <WKScriptMessageHandlerNotaImpl>WKScriptMessageHandlerNotaImpl.new();
        delegate.owner = owner;

        return delegate;
    }

    public userContentControllerDidReceiveScriptMessage(userContentController: WKUserContentController, webViewMessage: WKScriptMessage) {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        try {
            const message = JSON.parse(webViewMessage.body as string);
            owner.onWebViewEvent(message.eventName, message.data);
        } catch (err) {
            owner.writeTrace(
                `userContentControllerDidReceiveScriptMessage(${userContentController}, ${webViewMessage}) - bad message: ${JSON.stringify(webViewMessage.body)}`,
                Trace.messageType.error,
            );
        }
    }
}

@NativeClass()
export class WKUIDelegateNotaImpl extends NSObject implements WKUIDelegate {
    public static ObjCProtocols = [WKUIDelegate];
    public owner: WeakRef<WebViewExt>;

    public static initWithOwner(owner: WeakRef<WebViewExt>): WKUIDelegateNotaImpl {
        const delegate = <WKUIDelegateNotaImpl>WKUIDelegateNotaImpl.new();
        delegate.owner = owner;
        console.log(delegate);

        return delegate;
    }

    /**
     * Handle alerts from the webview
     */
    public webViewRunJavaScriptAlertPanelWithMessageInitiatedByFrameCompletionHandler(
        webView: WKWebView,
        message: string,
        frame: WKFrameInfo,
        completionHandler: () => void,
    ): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        let gotResponse = false;
        owner._webAlert(message, () => {
            if (!gotResponse) {
                completionHandler();
            }

            gotResponse = true;
        });
    }

    /**
     * Handle confirm dialogs from the webview
     */
    public webViewRunJavaScriptConfirmPanelWithMessageInitiatedByFrameCompletionHandler(
        webView: WKWebView,
        message: string,
        frame: WKFrameInfo,
        completionHandler: (confirmed: boolean) => void,
    ): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        let gotResponse = false;
        owner._webConfirm(message, (confirmed: boolean) => {
            if (!gotResponse) {
                completionHandler(confirmed);
            }

            gotResponse = true;
        });
    }

    /**
     * Handle prompt dialogs from the webview
     */
    public webViewRunJavaScriptTextInputPanelWithPromptDefaultTextInitiatedByFrameCompletionHandler(
        webView: WKWebView,
        message: string,
        defaultText: string,
        frame: WKFrameInfo,
        completionHandler: (response: string) => void,
    ): void {
        const owner = this.owner.get();
        if (!owner) {
            return;
        }

        let gotResponse = false;
        owner._webPrompt(message, defaultText, (response: string) => {
            if (!gotResponse) {
                completionHandler(response);
            }

            gotResponse = true;
        });
    }
}
