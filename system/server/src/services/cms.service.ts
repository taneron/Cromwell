import {
    findRedirect,
    getRandStr,
    resolvePageRoute,
    setStoreItem,
    sleep,
    TCCSVersion,
    TDefaultPageName,
    TOrder,
    TOrderInput,
    TPackageCromwellConfig,
    TProductReview,
    TStoreListItem,
    TUser,
    TUserRole,
} from '@cromwell/core';
import {
    applyGetPaged,
    AttributeRepository,
    BasePageEntity,
    cmsPackageName,
    CouponRepository,
    getCmsEntity,
    getCmsInfo,
    getCmsModuleInfo,
    getCmsSettings,
    getEmailTemplate,
    getLogger,
    getModulePackage,
    getNodeModuleDir,
    getPublicDir,
    getServerDir,
    getThemeConfigs,
    Order,
    OrderRepository,
    PageStats,
    PageStatsRepository,
    PostRepository,
    Product,
    ProductCategoryRepository,
    ProductRepository,
    ProductReview,
    ProductReviewRepository,
    readCmsModules,
    runShellCommand,
    sendEmail,
    TagRepository,
    User,
    UserRepository,
} from '@cromwell/core-backend';
import { getCentralServerClient, getCStore } from '@cromwell/core-frontend';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { format } from 'date-fns';
import fs from 'fs-extra';
import { join, resolve } from 'path';
import { pipeline } from 'stream';
import { Container, Service } from 'typedi';
import { getConnection, getCustomRepository, getManager, Repository } from 'typeorm';
import { DateUtils } from 'typeorm/util/DateUtils';
import * as util from 'util';

import { AdminCmsConfigDto } from '../dto/admin-cms-config.dto';
import { CmsStatsDto, SalePerDayDto } from '../dto/cms-stats.dto';
import { CmsStatusDto } from '../dto/cms-status.dto';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderTotalDto } from '../dto/order-total.dto';
import { PageStatsDto } from '../dto/page-stats.dto';
import { SetupDto } from '../dto/setup.dto';
import { SystemUsageDto } from '../dto/system-usage.dto';
import { getSysInfo, getSysUsageInfo } from '../helpers/monitor-client';
import { serverFireAction } from '../helpers/server-fire-action';
import { childSendMessage } from '../helpers/server-manager';
import { endTransaction, restartService, setPendingKill, startTransaction } from '../helpers/state-manager';
import { MockService } from './mock.service';
import { PluginService } from './plugin.service';
import { ThemeService } from './theme.service';

const logger = getLogger();
const pump = util.promisify(pipeline);

@Injectable()
@Service()
export class CmsService {

    private get pluginService() {
        return Container.get(PluginService);
    }

    private get themeService() {
        return Container.get(ThemeService);
    }

    private get mockService() {
        return Container.get(MockService);
    }

    constructor() {
        this.init();
    }

    private isRunningNpm = false;
    private cpuLoads: {
        time: Date;
        load: number;
    }[] = [];

    private async init() {
        await sleep(1);
        if (!getConnection()?.isConnected) return;

        // Schedule sitemap re-build once in a day
        setInterval(() => this.buildSitemap, 1000 * 60 * 60 * 24);
    }

    public async getIsRunningNpm() {
        return this.isRunningNpm;
    }

    public async setIsRunningNpm(isRunning) {
        this.isRunningNpm = isRunning;
    }

    private checkedYarn = false;

    public async checkYarn() {
        if (this.checkedYarn) return;
        this.checkedYarn = true;
        try {
            await runShellCommand(`npm i -g yarn`);
        } catch (error) {
            logger.error(error);
        }
    }

    public async setThemeName(themeName: string) {
        const entity = await getCmsEntity();
        if (entity) {
            entity.publicSettings = {
                ...(entity.publicSettings ?? {}),
                themeName,
            }
            await entity.save();
            return true;
        }
        return false;
    }

    async uploadFile(req: any, dirName: string): Promise<any> {
        if (!req.isMultipart()) {
            return;
        }
        const parts = req.files();
        for await (const part of parts) {
            const fullPath = join(`${dirName}/${part.filename}`);
            await pump(part.file, fs.createWriteStream(fullPath));
        }
    }

    public async parseModuleConfigImages(moduleInfo: TPackageCromwellConfig, moduleName: string) {
        if (!moduleInfo) return;

        if (moduleInfo.icon) {
            const moduleDir = await getNodeModuleDir(moduleName);
            // Read icon and convert to base64
            if (moduleDir) {
                const imgPath = resolve(moduleDir, moduleInfo?.icon);
                if (await fs.pathExists(imgPath)) {
                    const data = (await fs.readFile(imgPath))?.toString('base64');
                    if (data) moduleInfo.icon = data;
                }
            }
        }

        if (!moduleInfo.images) moduleInfo.images = [];

        if (moduleInfo.image) {
            // Read image and convert to base64
            const moduleDir = await getNodeModuleDir(moduleName);
            if (moduleDir) {
                const imgPath = resolve(moduleDir, moduleInfo.image);
                if (await fs.pathExists(imgPath)) {
                    const data = (await fs.readFile(imgPath))?.toString('base64');
                    if (data) moduleInfo.image = data;
                }
            }

            if (!moduleInfo.images.includes(moduleInfo.image))
                moduleInfo.images.push(moduleInfo.image);
        }
    }

    public async installCms(input: SetupDto) {
        if (!input.url)
            throw new HttpException('URL is not provided', HttpStatus.UNPROCESSABLE_ENTITY);

        const cmsEntity = await getCmsEntity();
        if (cmsEntity?.internalSettings?.installed) {
            logger.error('CMS already installed');
            throw new HttpException('CMS already installed', HttpStatus.BAD_REQUEST);
        }

        cmsEntity.internalSettings = {
            ...(cmsEntity.internalSettings ?? {}),
            installed: true,
        }

        cmsEntity.publicSettings = {
            ...(cmsEntity.publicSettings ?? {}),
            url: input.url,
        }
        await cmsEntity.save();

        const settings = await getCmsSettings();
        if (settings) {
            setStoreItem('cmsSettings', settings)
        }

        await this.mockService.mockAll();

        const serverDir = getServerDir();
        const publicDir = getPublicDir();
        if (!serverDir || !publicDir) return false;

        const robotsSource = resolve(serverDir, 'static/robots.txt');
        let robotsContent = await (await fs.readFile(robotsSource)).toString();
        robotsContent += `\n\nSitemap: ${input.url}/default_sitemap.xml`;
        await fs.outputFile(resolve(publicDir, 'robots.txt'), robotsContent, {
            encoding: 'UTF-8'
        });

        return true;
    }

    public async buildSitemap() {
        const settings = await getCmsSettings();
        if (!settings?.url) throw new HttpException("CmsService::buildSitemap: could not find website's URL", HttpStatus.INTERNAL_SERVER_ERROR);
        const configs = await getThemeConfigs();
        setStoreItem('defaultPages', configs.themeConfig?.defaultPages);

        const urls: string[] = [];
        let content = '';

        const addPage = (route: string, updDate: Date) => {
            if (!route.startsWith('/')) route = '/' + route;
            const redirect = findRedirect(route);
            if (redirect?.type === 'redirect' && redirect.to) {
                route = redirect.to;
            }

            if (redirect?.type === 'rewrite' && redirect.from === '/404') return;

            if (!route.startsWith('http')) {
                route = settings.url + route;
            }

            if (urls.includes(route)) return;
            urls.push(route);

            content +=
                `  <url>
    <loc>${route}</loc>
    <lastmod>${format(updDate, 'yyyy-MM-dd')}</lastmod>
  </url>\n`;
        }

        configs.themeConfig?.pages?.forEach(page => {
            if (!page.route || page.route.includes('[slug]') ||
                page.route.includes('[id]') || page.route === 'index'
                || page.route === '404') return;

            addPage(
                page.route,
                new Date(Date.now())
            );
        })

        const outputEntity = async (repo: Repository<any>, pageName: TDefaultPageName) => {
            const entities: BasePageEntity[] = await repo.find({
                select: ['slug', 'id', 'updateDate', 'createDate'],
            });

            entities.forEach(ent => {
                const updDate = ent.updateDate ?? ent.createDate;
                addPage(
                    resolvePageRoute(pageName, { slug: ent.slug ?? ent.id + '' }),
                    updDate ?? new Date(Date.now())
                );
            });

        }

        await outputEntity(getCustomRepository(PostRepository), 'post');
        await outputEntity(getCustomRepository(ProductRepository), 'product');
        await outputEntity(getCustomRepository(ProductCategoryRepository), 'category');
        await outputEntity(getCustomRepository(TagRepository), 'tag');

        content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${content}
</urlset>`;

        await fs.outputFile(resolve(getPublicDir(), 'default_sitemap.xml'), content, {
            encoding: 'UTF-8'
        });
        return true;
    }

    public async readPlugins(): Promise<TPackageCromwellConfig[]> {
        const out: TPackageCromwellConfig[] = [];

        const pluginModules = (await readCmsModules()).plugins;

        for (const pluginName of pluginModules) {
            const moduleInfo = await getCmsModuleInfo(pluginName);
            delete moduleInfo?.frontendDependencies;
            delete moduleInfo?.bundledDependencies;
            delete moduleInfo?.firstLoadedDependencies;

            if (moduleInfo) {
                await this.parseModuleConfigImages(moduleInfo, pluginName);
                out.push(moduleInfo);
            }
        }
        return out;
    }

    public async readThemes(): Promise<TPackageCromwellConfig[]> {
        const out: TPackageCromwellConfig[] = [];

        const themeModuleNames = (await readCmsModules()).themes;

        for (const themeName of themeModuleNames) {
            const moduleInfo = await getCmsModuleInfo(themeName);

            if (moduleInfo) {
                delete moduleInfo.frontendDependencies;
                delete moduleInfo.bundledDependencies;
                delete moduleInfo.firstLoadedDependencies;

                await this.parseModuleConfigImages(moduleInfo, themeName);
                out.push(moduleInfo);
            }
        }
        return out;
    }

    public async getAdminConfig() {
        const config = await getCmsSettings();
        const info = await getCmsInfo();
        if (!config) {
            throw new HttpException('CmsController::getPrivateConfig Failed to read CMS Config', HttpStatus.INTERNAL_SERVER_ERROR);
        }
        const dto = new AdminCmsConfigDto().parseConfig(config);
        dto.cmsInfo = info;
        try {
            const robotsPath = resolve(getPublicDir(), 'robots.txt');
            if (await fs.pathExists(robotsPath))
                dto.robotsContent = (await fs.readFile(robotsPath)).toString();
        } catch (error) {
            logger.error(error);
        }
        return dto;
    }

    public async updateCmsSettings(input: AdminCmsConfigDto): Promise<AdminCmsConfigDto> {
        const entity = await getCmsEntity();
        if (!entity) throw new Error('!entity');

        if (typeof input.currencies === 'string') {
            try {
                input.currencies = JSON.parse(input.currencies);
            } catch (error) {
                logger.error(error);
            }
        }

        entity.publicSettings = {
            url: input.url,
            defaultPageSize: input.defaultPageSize,
            currencies: input.currencies,
            timezone: input.timezone,
            language: input.language,
            favicon: input.favicon,
            logo: input.logo,
            headHtml: input.headHtml,
            footerHtml: input.footerHtml,
            defaultShippingPrice: input.defaultShippingPrice,
            customMeta: input.customMeta,
        }

        entity.adminSettings = {
            sendFromEmail: input.sendFromEmail,
            smtpConnectionString: input.smtpConnectionString,
            customFields: input.customFields,
            customEntities: input.customEntities,
        }

        await entity.save();

        if (input.robotsContent) {
            await fs.outputFile(resolve(getPublicDir(), 'robots.txt'), input.robotsContent, {
                encoding: 'UTF-8'
            });
        }

        const config = await getCmsSettings();
        if (!config) throw new HttpException('!config', HttpStatus.INTERNAL_SERVER_ERROR);
        return new AdminCmsConfigDto().parseConfig(config);
    }

    async viewPage(input: PageStatsDto) {
        if (!input?.pageRoute) return;

        let page: PageStats | undefined;
        try {
            page = await getManager().findOne(PageStats, {
                where: {
                    pageRoute: input.pageRoute
                }
            });
        } catch (error) { }

        if (page) {
            if (!page.views) page.views = 0;
            page.views++;
            await page.save();

        } else {
            const newPage = new PageStats();
            newPage.pageRoute = input.pageRoute;
            newPage.pageName = input.pageName;
            newPage.slug = input.slug;
            newPage.entityType = input.entityType;
            newPage.views = 1;
            await newPage.save();
        }
    }

    async placeOrder(input: CreateOrderDto): Promise<TOrder | undefined> {
        const orderTotal = await this.calcOrderTotal(input);
        const settings = await getCmsSettings();
        const { themeConfig } = await getThemeConfigs();

        // Clean up products
        if (orderTotal.cart?.length) {
            orderTotal.cart = orderTotal.cart.map(item => {
                if (item.pickedAttributes) {
                    if (Object.keys(item.pickedAttributes).length > 1000) item.pickedAttributes = undefined;
                }
                if (item.pickedAttributes) {
                    Object.keys(item.pickedAttributes).forEach(key => {
                        if (!item.pickedAttributes![key]?.length) {
                            delete item.pickedAttributes![key];
                        }
                        if (item.pickedAttributes![key].length > 1000) {
                            delete item.pickedAttributes![key];
                        }
                    })
                }
                if (item.product) item.product = {
                    id: item.product.id,
                    createDate: item.product.createDate,
                    updateDate: item.product.updateDate,
                    name: item.product.name,
                    mainCategoryId: item.product.mainCategoryId,
                    price: item.product.price,
                    oldPrice: item.product.oldPrice,
                    sku: item.product.sku,
                    mainImage: item.product.mainImage,
                    images: item.product.images,
                    attributes: item.product.attributes,
                    stockAmount: item.product.stockAmount,
                    stockStatus: item.product.stockStatus,
                    categories: item.product.categories?.map(cat => ({
                        id: cat.id,
                        name: cat.name,
                    })),
                }
                return {
                    amount: item.amount,
                    pickedAttributes: item.pickedAttributes,
                    product: item.product,
                }
            });
        }

        if (orderTotal.appliedCoupons?.length) {
            try {
                const coupons = await getCustomRepository(CouponRepository)
                    .getCouponsByCodes(orderTotal.appliedCoupons);

                for (const coupon of (coupons ?? [])) {
                    if (!coupon.usedTimes) coupon.usedTimes = 1;
                    else coupon.usedTimes++;
                    await coupon.save();
                }
            } catch (error) {
                logger.error(error);
            }
        }

        const createOrder: TOrderInput = {
            cartOldTotalPrice: orderTotal.cartOldTotalPrice,
            cartTotalPrice: orderTotal.cartTotalPrice,
            totalQnt: orderTotal.totalQnt,
            shippingPrice: orderTotal.shippingPrice,
            orderTotalPrice: orderTotal.orderTotalPrice,
            couponCodes: orderTotal.appliedCoupons,
            cart: orderTotal.cart,
            status: 'Pending',
            userId: input.userId,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail,
            customerAddress: input.customerAddress,
            customerComment: input.customerComment,
            shippingMethod: input.shippingMethod,
            paymentMethod: input.paymentMethod,
            fromUrl: input.fromUrl,
            currency: input.currency,
        }

        const fromUrl = input.fromUrl;
        const cstore = getCStore(true);
        if (createOrder.currency) {
            cstore.setActiveCurrency(createOrder.currency);
        }

        // < Send e-mail >
        setStoreItem('defaultPages', themeConfig?.defaultPages);
        try {
            if (input.customerEmail && fromUrl) {
                const mailProps = {
                    createDate: format(new Date(Date.now()), 'd MMMM yyyy'),
                    logoUrl: (settings?.logo) && fromUrl + '/' + settings.logo,
                    orderLink: (themeConfig?.defaultPages?.account) && fromUrl + '/' + themeConfig.defaultPages.account,
                    totalPrice: cstore.getPriceWithCurrency((orderTotal.orderTotalPrice ?? 0).toFixed(2)),
                    unsubscribeUrl: fromUrl,
                    products: (orderTotal.cart ?? []).map(item => {
                        return {
                            link: (themeConfig?.defaultPages?.product && item?.product?.slug) ?
                                resolvePageRoute('product', { slug: item.product.slug }) : '/',
                            title: `${item?.amount ? item.amount + ' x ' : ''}${item?.product?.name ?? ''}`,
                            price: cstore.getPriceWithCurrency(((item.product?.price ?? 0) * (item.amount ?? 1)).toFixed(2)),
                        }
                    }),
                    shippingPrice: cstore.getPriceWithCurrency((orderTotal.shippingPrice ?? 0).toFixed(2)),
                }

                const compiledEmail = await getEmailTemplate('order.hbs', mailProps);
                if (!compiledEmail) {
                    logger.error('order.hbs template was not found');
                    throw new HttpException('order.hbs template was not found', HttpStatus.INTERNAL_SERVER_ERROR);
                }

                await sendEmail([input.customerEmail], 'Order', compiledEmail);
            }

        } catch (error) {
            logger.error(error);
        }
        // < / Send e-mail >

        return getCustomRepository(OrderRepository).createOrder(createOrder);
    }

    async calcOrderTotal(input: CreateOrderDto): Promise<OrderTotalDto> {
        const orderTotal = new OrderTotalDto();
        orderTotal.successUrl = input.successUrl;
        orderTotal.cancelUrl = input.cancelUrl;
        orderTotal.fromUrl = input.fromUrl;
        orderTotal.currency = input.currency;

        let cart: TStoreListItem[] | undefined;
        try {
            if (typeof input.cart === 'string') {
                cart = JSON.parse(input.cart);
            } else if (typeof input.cart === 'object') {
                cart = input.cart;
            }
        } catch (error) {
            logger.error('placeOrder: Failed to parse cart', error);
        }
        if (typeof cart !== 'object') return orderTotal;

        const settings = await getCmsSettings();

        const cstore = getCStore(true, {
            getProductById: (id) => getCustomRepository(ProductRepository).getProductById(id,
                { withAttributes: true, withCategories: true, }),
            getAttributes: () => getCustomRepository(AttributeRepository).getAttributes(),
            getCouponsByCodes: (codes) => getCustomRepository(CouponRepository)
                .getCouponsByCodes(codes)
        });

        if (input.currency) {
            cstore.setActiveCurrency(input.currency);
        }

        cstore.saveCart(cart);
        await cstore.applyCouponCodes(input.couponCodes);
        await cstore.updateCart();
        const total = cstore.getCartTotal();

        orderTotal.cart = cstore.getCart();
        orderTotal.cartOldTotalPrice = total.totalOld;
        orderTotal.cartTotalPrice = total.total ?? 0;
        orderTotal.totalQnt = total.amount;
        orderTotal.appliedCoupons = total.coupons.map(coupon => coupon.code!);

        orderTotal.shippingPrice = settings?.defaultShippingPrice ?
            parseFloat(settings?.defaultShippingPrice + '') : 0;
        orderTotal.shippingPrice = parseFloat(orderTotal.shippingPrice.toFixed(2));

        orderTotal.orderTotalPrice = (orderTotal?.cartTotalPrice ?? 0) + (orderTotal?.shippingPrice ?? 0);
        orderTotal.orderTotalPrice = parseFloat(orderTotal.orderTotalPrice.toFixed(2));
        return orderTotal;
    }

    async createPaymentSession(input: CreateOrderDto): Promise<OrderTotalDto> {
        const total = await this.calcOrderTotal(input);
        total.cart = total.cart?.filter(item => item?.product);

        if (!total.cart?.length) throw new HttpException('Cart is invalid or empty', HttpStatus.BAD_REQUEST);

        const payments = await serverFireAction('create_payment', total);
        total.paymentOptions = Object.values(payments ?? {});
        return total;
    }

    async getCmsStats(): Promise<CmsStatsDto> {
        const stats = new CmsStatsDto();

        // Reviews
        const reviewsCountKey: keyof Product = 'reviewsCount';
        const averageKey: keyof Product = 'averageRating';
        const ratingKey: keyof TProductReview = 'rating';
        const reviewTable = getCustomRepository(ProductReviewRepository).metadata.tablePath;

        // Orders
        const orderTable = getCustomRepository(OrderRepository).metadata.tablePath;
        const totalPriceKey: keyof TOrder = 'orderTotalPrice';
        const orderCountKey = 'orderCount';
        const days = 7;

        // Page stats 
        const pageStatsTable = getCustomRepository(PageStatsRepository).metadata.tablePath;
        const viewsPagesCountKey = 'viewsPagesCount';
        const viewsSumKey: keyof PageStats = 'views';

        // Customers
        const userCountKey = 'userCount';
        const userRoleKey: keyof TUser = 'role';
        const userTable = getCustomRepository(UserRepository).metadata.tablePath;


        const getReviews = async () => {
            const reviewsStats = await getManager().createQueryBuilder(ProductReview, reviewTable)
                .select([])
                .addSelect(`AVG(${reviewTable}.${ratingKey})`, averageKey)
                .addSelect(`COUNT(${reviewTable}.id)`, reviewsCountKey).execute();

            stats.averageRating = reviewsStats?.[0]?.[averageKey];
            stats.reviews = parseInt((reviewsStats?.[0]?.[reviewsCountKey] ?? 0) + '');
        }

        const getOrders = async () => {
            const ordersStats = await getManager().createQueryBuilder(Order, orderTable)
                .select([])
                .addSelect(`SUM(${orderTable}.${totalPriceKey})`, totalPriceKey)
                .addSelect(`COUNT(${orderTable}.id)`, orderCountKey).execute();

            stats.orders = parseInt((ordersStats?.[0]?.[orderCountKey] ?? 0) + '');
            stats.salesValue = ordersStats?.[0]?.[totalPriceKey];
        }

        const getSalesPerDay = async () => {
            stats.salesPerDay = [];

            for (let i = 0; i < days; i++) {
                const dateFrom = new Date(Date.now());
                dateFrom.setUTCDate(dateFrom.getUTCDate() - i);
                dateFrom.setUTCHours(0);
                dateFrom.setUTCMinutes(0);

                const dateTo = new Date(dateFrom);
                dateTo.setDate(dateTo.getDate() + 1);

                const ordersStats = await getManager().createQueryBuilder(Order, orderTable)
                    .select([])
                    .addSelect(`SUM(${orderTable}.${totalPriceKey})`, totalPriceKey)
                    .addSelect(`COUNT(${orderTable}.id)`, orderCountKey)
                    .where(`${orderTable}.createDate BETWEEN :dateFrom AND :dateTo`, {
                        dateFrom: DateUtils.mixedDateToDatetimeString(dateFrom),
                        dateTo: DateUtils.mixedDateToDatetimeString(dateTo),
                    })
                    .execute();

                const sales = new SalePerDayDto();
                sales.orders = parseInt((ordersStats?.[0]?.[orderCountKey] ?? 0) + '');
                sales.salesValue = ordersStats?.[0]?.[totalPriceKey] ?? 0;
                sales.date = dateFrom;

                stats.salesPerDay.push(sales);
            }
        }

        const getPageViews = async () => {
            const viewsStats = await getManager().createQueryBuilder(PageStats, pageStatsTable)
                .select([])
                .addSelect(`SUM(${pageStatsTable}.${viewsSumKey})`, viewsSumKey)
                .addSelect(`COUNT(${pageStatsTable}.id)`, viewsPagesCountKey).execute();

            stats.pages = parseInt((viewsStats?.[0]?.[viewsPagesCountKey] ?? 0) + '');
            stats.pageViews = viewsStats?.[0]?.[viewsSumKey];
        }

        const getTopPageViews = async () => {
            const viewsStats = await applyGetPaged(
                getManager().createQueryBuilder(PageStats, pageStatsTable).select(), pageStatsTable, {
                order: 'DESC',
                orderBy: 'views',
                pageSize: 15
            }).getMany();

            stats.topPageViews = await Promise.all(viewsStats.map(async stat => {
                stat.pageRoute = await resolvePageRoute(stat.pageRoute);
                return {
                    pageRoute: stat.pageRoute,
                    views: stat.views,
                }
            }))
        }

        const getCustomers = async () => {
            const customersStats = await getManager().createQueryBuilder(User, userTable)
                .select([])
                .addSelect(`COUNT(${userTable}.id)`, userCountKey)
                .where(`${userTable}.${userRoleKey} = :role`, { role: 'customer' as TUserRole })
                .execute();

            stats.customers = parseInt((customersStats?.[0]?.[userCountKey] ?? 0) + '');
        }

        await Promise.all([
            getReviews(),
            getOrders(),
            getPageViews(),
            getCustomers(),
            getSalesPerDay(),
            getTopPageViews(),
        ]);

        return stats;
    }

    async getSystemUsage(): Promise<SystemUsageDto> {
        const [info, usage] = await Promise.all([
            getSysInfo(),
            getSysUsageInfo()
        ]);

        const dto = new SystemUsageDto().parseSysInfo(info).parseSysUsage(usage);

        if (dto.cpuUsage?.currentLoad !== undefined) {
            this.cpuLoads.push({
                load: dto.cpuUsage.currentLoad,
                time: new Date(Date.now()),
            });

            if (this.cpuLoads.length > 30) this.cpuLoads = this.cpuLoads.slice(this.cpuLoads.length - 30, this.cpuLoads.length)
        }

        if (dto.cpuUsage) {
            dto.cpuUsage.previousLoads = this.cpuLoads;
        }
        return dto;
    }

    async checkCmsUpdate(): Promise<TCCSVersion | undefined> {
        const settings = await getCmsSettings();
        const cmsPckg = await getModulePackage(cmsPackageName);
        const isBeta = !!settings?.beta;
        try {
            return await getCentralServerClient().checkCmsUpdate(settings?.version ?? cmsPckg?.version ?? '0', isBeta);
        } catch (error) { }
    }

    async getCmsStatus(): Promise<CmsStatusDto> {
        const status = new CmsStatusDto();
        const settings = await getCmsSettings();
        const availableUpdate = await this.checkCmsUpdate();
        status.updateAvailable = !!availableUpdate;
        status.updateInfo = availableUpdate;
        status.isUpdating = settings?.isUpdating;
        status.currentVersion = settings?.version;

        status.notifications = [];

        if (!settings?.smtpConnectionString) {
            status.notifications.push({
                type: 'warning',
                message: 'Setup SMTP settings',
                documentationLink: 'https://cromwellcms.com/docs/features/mail',
                pageLink: '/admin/settings'
            })
        }

        return status;
    }

    async handleUpdateCms() {
        const transactionId = getRandStr(8);
        startTransaction(transactionId);
        if (await this.getIsRunningNpm()) {
            throw new HttpException('Only one install/update available at the time', HttpStatus.METHOD_NOT_ALLOWED);
        }
        this.setIsRunningNpm(true);
        await this.checkYarn();

        let success = false;
        let error: any;
        try {
            success = await this.updateCms();
        } catch (err) {
            error = err;
        }

        await this.setIsRunningNpm(false);
        endTransaction(transactionId);

        if (!success) {
            logger.error(error);
            throw new HttpException(error?.message, error?.status);
        }
        return true;
    }

    async updateCms(): Promise<boolean> {
        const availableUpdate = await this.checkCmsUpdate();
        if (!availableUpdate?.packageVersion) throw new HttpException(`Update failed: !availableUpdate?.packageVersion`, HttpStatus.INTERNAL_SERVER_ERROR);
        if (availableUpdate.onlyManualUpdate) throw new HttpException(`Update failed: Cannot launch automatic update. Please update using npm install command and restart CMS`, HttpStatus.FORBIDDEN);

        const pckg = await getModulePackage();
        if (!pckg?.dependencies?.[cmsPackageName])
            throw new HttpException(`Update failed: Could not find ${cmsPackageName} in package.json`, HttpStatus.INTERNAL_SERVER_ERROR);

        const cmsPckgOld = await getModulePackage(cmsPackageName);
        const versionOld = cmsPckgOld?.version;
        if (!versionOld)
            throw new HttpException(`Update failed: Could not find ${cmsPackageName} package`, HttpStatus.INTERNAL_SERVER_ERROR);

        await runShellCommand(`yarn upgrade ${cmsPackageName}@${availableUpdate.packageVersion} --exact --non-interactive`);
        await sleep(1);

        const cmsPckg = await getModulePackage(cmsPackageName);
        if (!cmsPckg?.version || cmsPckg.version !== availableUpdate.packageVersion)
            throw new HttpException(`Update failed: cmsPckg.version !== availableUpdate.packageVersion`, HttpStatus.INTERNAL_SERVER_ERROR);


        const cmsEntity = await getCmsEntity();
        cmsEntity.internalSettings = {
            ...(cmsEntity.internalSettings ?? {}),
            version: availableUpdate.version,
        }

        await cmsEntity.save();
        await getCmsSettings();

        for (const service of (availableUpdate?.restartServices ?? [])) {
            // Restarts entire service by Manager service
            await restartService(service);
        }
        await sleep(1);

        if ((availableUpdate?.restartServices ?? []).includes('api-server')) {

            // Restart API server by Proxy manager
            const resp1 = await childSendMessage('make-new');
            if (resp1.message !== 'success') {
                // Rollback
                await runShellCommand(`yarn upgrade ${cmsPackageName}@${versionOld} --save --non-interactive`);
                await sleep(1);

                throw new HttpException('Could not start server after update', HttpStatus.INTERNAL_SERVER_ERROR);
            } else {
                const resp2 = await childSendMessage('apply-new', resp1.payload);

                if (resp2.message !== 'success') throw new HttpException('Could not apply new server after update', HttpStatus.INTERNAL_SERVER_ERROR);

                setPendingKill(2000);
            }
        }

        return true;
    }


    async installModuleDependencies(moduleName: string) {
        const pckg = await getModulePackage(moduleName);

        for (const pluginName of (pckg?.cromwell?.plugins ?? [])) {
            const pluginPckg = await getModulePackage(pluginName);
            if (pluginPckg) continue;

            try {
                await this.pluginService.handleInstallPlugin(pluginName);
            } catch (error) {
                logger.error(error);
            }
        }

        for (const themeName of (pckg?.cromwell?.themes ?? [])) {
            const themePckg = await getModulePackage(themeName);
            if (themePckg) continue;

            try {
                await this.themeService.handleInstallTheme(themeName);
            } catch (error) {
                logger.error(error);
            }
        }
    }
}
