"""Marshmallow schemas package."""
from .attendant_schema import AttendantSchema, LoginSchema
from .product_schema import ProductSchema
from .batch_schema import StockBatchSchema, BatchCreateSchema
from .sale_schema import SaleSchema, SaleSyncItemSchema
from .wastage_schema import WastageSchema, WastageCreateSchema

__all__ = [
    "AttendantSchema",
    "LoginSchema",
    "ProductSchema",
    "StockBatchSchema",
    "BatchCreateSchema",
    "SaleSchema",
    "SaleSyncItemSchema",
    "WastageSchema",
    "WastageCreateSchema",
]
