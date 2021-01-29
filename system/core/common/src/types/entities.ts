import { TPagedList } from './data';

export type TBasePageEntity = {
    // DB id
    id: string;
    // Slug for page route
    slug?: string;
    // Page SEO title
    pageTitle?: string;
    // Page SEO description
    pageDescription?: string;
    // DB createDate
    createDate: Date;
    // DB updateDate
    updateDate: Date;
    // Is displaying at frontend
    isEnabled?: boolean;
}

type TDBAuxiliaryColumns = 'id' | 'createDate' | 'updateDate';

export type TBasePageEntityInput = Omit<TBasePageEntity, TDBAuxiliaryColumns>;


// ProductCategory

type TProductCategoryCore = {
    // Name of the category (h1)
    name: string;
    // Href of main image
    mainImage?: string;
    // Description (HTML allowed)
    description?: string;
    // DB children
    children?: TProductCategory[];
    // DB parent
    parent?: TProductCategory;
    // Products in category
    products?: TPagedList<TProduct>;
}

export type TProductCategory = TProductCategoryCore & TBasePageEntity;

export type TProductCategoryInput = TBasePageEntityInput & Omit<TProductCategoryCore, 'children' | 'parent' | 'products'> & {
    parentId?: string;
    childIds?: string[];
};


// PRODUCT

export interface TProduct extends TBasePageEntity {
    // Name of the product (h1)
    name: string;
    // Categories of the prooduct
    categories: TProductCategory[];
    // Price. Will be discount price if oldPrice is specified
    price?: number;
    // Price before sale, optional
    oldPrice?: number;
    // Href of main image
    mainImage?: string;
    // Hrefs of iamges
    images?: string[];
    // Description (HTML allowed)
    description?: string;
    // Rating data
    rating?: TProductRating;
    // Customer reviews 
    reviews?: TProductReview[];
    // Custom attributes
    attributes?: TAttributeInstance[];
    // Qnt of page requests
    views?: number;
}

export type TProductRating = {
    // Rating 1-5
    average?: number;
    // Number of customer reviews
    reviewsNumber?: number;
}

export type TProductInput = Omit<TProduct, TDBAuxiliaryColumns | 'categories' | 'rating' | 'reviews'> & {
    categoryIds?: string[];
};


// POST

export interface TPost extends TBasePageEntity {
    // Title of post (h1)
    title: string;
    // User-author
    author?: TUser;
    // Href of main image
    mainImage?: string;
    // Post content, HTML
    content: string;
    // Post content, stringified JSON from Quill.js
    delta: string;
    // Is published?
    isPublished: boolean;
}

export type TPostInput = Omit<TPost, TDBAuxiliaryColumns | 'author'> & {
    authorId: string;
};


// USER / AUTHOR

export interface TUser extends TBasePageEntity {
    // Name
    fullName: string;
    // E-mail
    email: string;
    // Avatar image
    avatar?: string;
}

export type TUserInput = Omit<TUser, TDBAuxiliaryColumns> & {
    password: string;
};



// Attribute

type TAttributeCore = {
    key: string;
    values: TAttributeValue[];
    type: 'radio' | 'checkbox';
    icon?: string;
}
export type TAttribute = TAttributeCore & TBasePageEntity;

export type TAttributeInput = TAttributeCore & TBasePageEntityInput;

export type TAttributeValue = {
    value: string;
    icon?: string;
}

export type TAttributeInstance = {
    key: string;
    values: TAttributeInstanceValue[];
}

export type TAttributeInstanceValue = {
    value: string;
    productVariant?: TAttributeProductVariant;
}

export type TAttributeProductVariant = {
    name?: string;
    price?: number;
    oldPrice?: number;
    mainImage?: string;
    images?: string[];
    description?: string;
}


// ProductReview

type TProductReviewCore = {
    productId: string;
    title?: string;
    description?: string;
    rating?: number;
    userName?: string;
}

export type TProductReview = TProductReviewCore & TBasePageEntity;

export type TProductReviewInput = TProductReviewCore & TBasePageEntityInput;


// Theme entity

type TThemeEntityCore = {
    name: string;
    isInstalled: boolean;
    hasAdminBundle?: boolean;
    title?: string;
    settings?: string;
    defaultSettings?: string;
}

export type TThemeEntity = TThemeEntityCore & TBasePageEntity;

export type TThemeEntityInput = TThemeEntityCore & TBasePageEntityInput;


// Plugin entity

type TPluginEntityCore = {
    name: string;
    title?: string;
    isInstalled: boolean;
    hasAdminBundle?: boolean;
    settings?: string;
    defaultSettings?: string;
}

export type TPluginEntity = TPluginEntityCore & TBasePageEntity;

export type TPluginEntityInput = TPluginEntityCore & TBasePageEntityInput;



// CMS entity

export type TCmsEntityCore = {
    protocol?: 'http' | 'https';
    themeName?: string;
    defaultPageSize?: number;
    currencies?: TCurrency[];
}

export type TCurrency = {
    tag: string;
    title?: string;
    /** Local curency symbols that will be added to price in getPriceWithCurrency method */
    symbol?: string;
    /** Ratio for currencies to compare: "USD": 1,"EURO": 0.8, etc. */
    ratio?: number;
}

export type TCmsEntity = TCmsEntityCore & TBasePageEntity;

export type TCmsEntityInput = TCmsEntityCore & TBasePageEntityInput;