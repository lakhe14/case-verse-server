'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const { idParam, z, id } = require('../../validators/common');
const ctrl = require('../../controllers/admin/catalog.controller');
const attrCtrl = require('../../controllers/attribute.controller');
const v = require('../../validators/product.validators');

const router = express.Router();
const canManage = requirePermission('manage_products');

const variantParam = z.object({ id, variantId: id });
const imageParam = z.object({ id, imageId: id });

// Attributes (the vocabulary: "Phone Model", "Color", …)
router.post('/attributes', canManage, validate({ body: v.attributeSchema }), attrCtrl.create);
router.put('/attributes/:id', canManage, validate({ params: idParam, body: v.attributeSchema }), attrCtrl.rename);
router.delete('/attributes/:id', canManage, validate({ params: idParam }), attrCtrl.remove);

// Categories + which attributes apply to each
router.get('/categories', canManage, attrCtrl.listCategories);
router.post('/categories', canManage, validate({ body: v.createCategorySchema }), ctrl.createCategory);
router.put(
  '/categories/:id/attributes',
  canManage,
  validate({ params: idParam, body: v.setCategoryAttributesSchema }),
  attrCtrl.setCategoryAttributes
);

// Products
router.get('/products', canManage, validate({ query: v.listProductsQuery.partial() }), ctrl.listProducts);
router.post('/products', canManage, validate({ body: v.createProductSchema }), ctrl.createProduct);
router.get('/products/:id', canManage, validate({ params: idParam }), ctrl.getProduct);
router.put('/products/:id', canManage, validate({ params: idParam, body: v.updateProductSchema }), ctrl.updateProduct);
router.delete('/products/:id', canManage, validate({ params: idParam }), ctrl.deleteProduct);

// Variants
router.post('/products/:id/variants', canManage, validate({ params: idParam, body: v.createVariantSchema }), ctrl.createVariant);
router.put('/products/:id/variants/:variantId', canManage, validate({ params: variantParam, body: v.updateVariantSchema }), ctrl.updateVariant);
router.delete('/products/:id/variants/:variantId', canManage, validate({ params: variantParam }), ctrl.deleteVariant);

// Images
router.post('/products/:id/images', canManage, upload.arrayCompressed('images', 8), validate({ params: idParam }), ctrl.uploadImages);
router.delete('/products/:id/images/:imageId', canManage, validate({ params: imageParam }), ctrl.deleteImage);

module.exports = router;
