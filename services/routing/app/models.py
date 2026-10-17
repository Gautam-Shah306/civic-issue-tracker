"""Pydantic models for routing requests and responses."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class WardPatch(BaseModel):
    """Schema for updating ward properties."""

    name: str | None = Field(None, min_length=1, max_length=100)
    active: bool | None = None

    model_config = ConfigDict(extra="forbid")


class DepartmentCreate(BaseModel):
    """Schema for creating a department."""

    code: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9-]+$")
    name: str = Field(..., min_length=1, max_length=100)
    email: str = Field(..., pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    active: bool = True

    model_config = ConfigDict(extra="forbid")


class DepartmentPatch(BaseModel):
    """Schema for updating department properties."""

    name: str | None = Field(None, min_length=1, max_length=100)
    email: str | None = Field(None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    active: bool | None = None

    model_config = ConfigDict(extra="forbid")


class CategoryCreate(BaseModel):
    """Schema for creating a civic issue category."""

    slug: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9-]+$")
    name: str = Field(..., min_length=1, max_length=100)
    departmentCode: str = Field(..., min_length=1, max_length=50)
    active: bool = True

    model_config = ConfigDict(extra="forbid")


class CategoryPatch(BaseModel):
    """Schema for updating category properties."""

    name: str | None = Field(None, min_length=1, max_length=100)
    departmentCode: str | None = Field(None, min_length=1, max_length=50)
    active: bool | None = None

    model_config = ConfigDict(extra="forbid")


class ReassignReportRequest(BaseModel):
    """Schema for manual report reassignment."""

    departmentCode: str = Field(..., min_length=1, max_length=50)
    wardCode: str | None = Field(None, min_length=1, max_length=16)

    model_config = ConfigDict(extra="forbid")


class CreateAssignmentRequest(BaseModel):
    """Schema for direct manual report assignment."""

    reportId: str = Field(..., min_length=1)
    departmentCode: str = Field(..., min_length=1, max_length=50)
    wardCode: str | None = Field(None, min_length=1, max_length=16)

    model_config = ConfigDict(extra="forbid")


class DepartmentResponse(BaseModel):
    """Department resource representation."""

    code: str
    name: str
    email: str
    active: bool


class CategoryResponse(BaseModel):
    """Category resource representation."""

    slug: str
    name: str
    departmentCode: str
    active: bool


class AssignmentResponse(BaseModel):
    """Report assignment record representation."""

    reportId: str
    wardCode: str | None
    departmentCode: str
    source: str
    assignedAt: str


class GeoJSONFeature(BaseModel):
    """GeoJSON Feature representation."""

    type: str = "Feature"
    id: str
    properties: dict[str, Any]
    geometry: dict[str, Any]


class GeoJSONFeatureCollection(BaseModel):
    """GeoJSON FeatureCollection representation."""

    type: str = "FeatureCollection"
    features: list[GeoJSONFeature]
