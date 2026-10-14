import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Inventory, InventoryDocument } from './schemas/inventory.schema';
import { CreateInventoryDto } from './dto/create-inventory.dto';
import { AddStockDto } from './dto/add-stock.dto';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { StockMovementsService } from '../stock-movements/stock-movements.service';

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(Inventory.name)
    public readonly inventoryModel: Model<InventoryDocument>,
    private readonly movementsService: StockMovementsService,
  ) {}

  // 1. إضافة مخزون/مجموعة جديدة
  async create(
    createInventoryDto: CreateInventoryDto,
    userId: string,
  ): Promise<InventoryDocument> {
    const {
      initialCount,
      totalGrossWeight,
      title,
      companyName,
      tagDetails,
      category,
      karat,
    } = createInventoryDto;

    let totalTagsWeight = 0;
    let totalTagsCount = 0;

    if (tagDetails && tagDetails.length > 0) {
      for (const tag of tagDetails) {
        totalTagsWeight += tag.count * tag.weight;
        totalTagsCount += tag.count;
      }
    }

    if (totalTagsCount > initialCount) {
      throw new BadRequestException(
        'إجمالي عدد القطع المحددة بالتيكت يتخطى العدد الكلي للبضاعة!',
      );
    }

    const totalNetWeight = parseFloat(
      (totalGrossWeight - totalTagsWeight).toFixed(3),
    );
    if (totalGrossWeight > 0 && totalNetWeight <= 0) {
      throw new BadRequestException(
        'الوزن الصافي الناتج أقل من أو يساوي صفر! يرجى مراجعة أوزان التيكت.',
      );
    }

    const cleanedCompanyName =
      companyName && companyName.trim() !== '' ? companyName.trim() : '-';

    const categoryObjectId = new Types.ObjectId(category);

    const existing = await this.inventoryModel.findOne({
      title: title.trim(),
      category: categoryObjectId,
      karat,
      companyName: cleanedCompanyName,
      isArchived: false,
    });

    if (existing) {
      return existing;
    }

    const newInventory = new this.inventoryModel({
      ...createInventoryDto,
      title: title.trim(),
      category: categoryObjectId,
      companyName: cleanedCompanyName,
      initialCount: initialCount || 0,
      currentCount: initialCount || 0,
      initialGrossWeight: totalGrossWeight || 0,
      initialNetWeight: totalNetWeight || 0,
      totalGrossWeight: totalGrossWeight || 0,
      totalNetWeight: totalNetWeight || 0,
      tagDetails: tagDetails || [],
    });

    const savedItem = await newInventory.save();

    await this.movementsService.logMovement({
      inventoryItem: savedItem._id.toString(),
      type: 'INVENTORY_IN',
      countChange: savedItem.initialCount,
      grossWeightChange: savedItem.totalGrossWeight,
      netWeightChange: savedItem.totalNetWeight,
      actionBy: userId,
      reason: `إنشاء مجموعة مخزون لشركة (${savedItem.companyName}) باسم: ${title} - عيار ${savedItem.karat} - وزن قائم ابتدائي: ${totalGrossWeight}ج`,
    });

    return savedItem;
  }

  // 2. تزويد كمية إضافية (Restock) مع المزامنة التلقائية لـ tagDetails والأوزان الحالية والابتدائية
  async addStock(
    id: string,
    addStockDto: AddStockDto,
    userId: string,
  ): Promise<InventoryDocument> {
    const { count, grossWeight, tagDetails } = addStockDto;

    const item = await this.inventoryModel
      .findOne({ _id: id, isArchived: false })
      .exec();

    if (!item) {
      throw new NotFoundException('البضاعة المطلوبة غير موجودة أو مؤرشفة');
    }

    let addedTagsWeight = 0;
    let addedTagsCount = 0;

    if (tagDetails && tagDetails.length > 0) {
      for (const tag of tagDetails) {
        addedTagsWeight += tag.count * tag.weight;
        addedTagsCount += tag.count;
      }
    }

    if (addedTagsCount > count) {
      throw new BadRequestException(
        'عدد القطع المحددة بالتيكت للدفعة الجديدة يتخطى العدد المضاف!',
      );
    }

    const addedNetWeight = parseFloat(
      (grossWeight - addedTagsWeight).toFixed(3),
    );

    if (addedNetWeight <= 0) {
      throw new BadRequestException(
        'الوزن الصافي للدفعة المضافة أقل من أو يساوي صفر! مراجعة أوزان التيكت.',
      );
    }

    const updatedTagDetails = item.tagDetails.map((t) => ({
      count: t.count,
      weight: t.weight,
    }));

    if (tagDetails && tagDetails.length > 0) {
      for (const newTag of tagDetails) {
        const existingTagIndex = updatedTagDetails.findIndex(
          (t) =>
            Number(t.weight.toFixed(3)) === Number(newTag.weight.toFixed(3)),
        );
        if (existingTagIndex > -1) {
          updatedTagDetails[existingTagIndex].count += newTag.count;
        } else {
          updatedTagDetails.push({
            count: newTag.count,
            weight: newTag.weight,
          });
        }
      }
    }

    const newInitialCount = item.initialCount + count;
    const newCurrentCount = item.currentCount + count;
    const newInitialGrossWeight = parseFloat(
      ((item.initialGrossWeight || 0) + grossWeight).toFixed(3),
    );
    const newInitialNetWeight = parseFloat(
      ((item.initialNetWeight || 0) + addedNetWeight).toFixed(3),
    );
    const newTotalGrossWeight = parseFloat(
      (item.totalGrossWeight + grossWeight).toFixed(3),
    );
    const newTotalNetWeight = parseFloat(
      (item.totalNetWeight + addedNetWeight).toFixed(3),
    );

    item.initialCount = newInitialCount;
    item.currentCount = newCurrentCount;
    item.initialGrossWeight = newInitialGrossWeight;
    item.initialNetWeight = newInitialNetWeight;
    item.totalGrossWeight = newTotalGrossWeight;
    item.totalNetWeight = newTotalNetWeight;
    item.tagDetails = updatedTagDetails;

    const savedItem = await item.save();

    await this.movementsService.logMovement({
      inventoryItem: savedItem._id.toString(),
      type: 'INVENTORY_IN',
      countChange: count,
      grossWeightChange: grossWeight,
      netWeightChange: addedNetWeight,
      actionBy: userId,
      reason: `إضافة كمية إضافية (+${count} قطعة) لـ (${savedItem.title}) - عيار ${savedItem.karat} - وزن قائم مضاف: ${grossWeight}ج`,
    });

    return savedItem;
  }

  // 3. تحديث المخزن المباشر وإعادة تسوية الصافي والابتدائي
  async update(
    id: string,
    updateInventoryDto: UpdateInventoryDto,
    userId: string,
  ): Promise<InventoryDocument> {
    const oldItem = await this.inventoryModel
      .findOne({ _id: id, isArchived: false })
      .exec();
    if (!oldItem)
      throw new NotFoundException('مجموعة الذهب المطلوبة غير موجودة أو مؤرشفة');

    const updateData: Record<string, any> = { ...updateInventoryDto };

    if (updateInventoryDto.title !== undefined) {
      updateData.title = updateInventoryDto.title.trim();
    }

    if (updateInventoryDto.companyName !== undefined) {
      updateData.companyName = updateInventoryDto.companyName.trim() || '-';
    }

    if (updateInventoryDto.category) {
      updateData.category = new Types.ObjectId(updateInventoryDto.category);
    }

    const targetInitialCount =
      updateInventoryDto.initialCount !== undefined
        ? updateInventoryDto.initialCount
        : oldItem.initialCount;
    const targetGrossWeight =
      updateInventoryDto.totalGrossWeight !== undefined
        ? updateInventoryDto.totalGrossWeight
        : oldItem.totalGrossWeight;
    const targetTagDetails =
      updateInventoryDto.tagDetails !== undefined
        ? updateInventoryDto.tagDetails
        : oldItem.tagDetails;

    let totalTagsWeight = 0;
    if (targetTagDetails && targetTagDetails.length > 0) {
      for (const tag of targetTagDetails) {
        totalTagsWeight += tag.count * tag.weight;
      }
    }

    const countDifference = targetInitialCount - oldItem.initialCount;
    const grossWeightDifference = parseFloat(
      (targetGrossWeight - oldItem.totalGrossWeight).toFixed(3),
    );

    const targetNetWeight = parseFloat(
      (targetGrossWeight - totalTagsWeight).toFixed(3),
    );
    if (targetGrossWeight > 0 && targetNetWeight <= 0)
      throw new BadRequestException('الوزن الصافي المحدث أقل من أو يساوي صفر!');

    const netWeightDifference = parseFloat(
      (targetNetWeight - oldItem.totalNetWeight).toFixed(3),
    );
    const newCurrentCount = oldItem.currentCount + countDifference;

    if (newCurrentCount < 0)
      throw new BadRequestException(
        'لا يمكن تقليل العدد ليكون أقل من القطع المباعة بالفعل!',
      );

    updateData.currentCount = newCurrentCount;
    updateData.totalNetWeight = targetNetWeight;
    updateData.tagDetails = targetTagDetails;

    if (updateInventoryDto.initialGrossWeight !== undefined) {
      updateData.initialGrossWeight = updateInventoryDto.initialGrossWeight;
    }
    if (updateInventoryDto.initialNetWeight !== undefined) {
      updateData.initialNetWeight = updateInventoryDto.initialNetWeight;
    }

    const updatedItem = await this.inventoryModel
      .findByIdAndUpdate(id, { $set: updateData }, { new: true })
      .populate('category', 'name')
      .exec();

    if (!updatedItem) {
      throw new NotFoundException('مجموعة الذهب المطلوبة غير موجودة أو مؤرشفة');
    }

    if (countDifference !== 0 || grossWeightDifference !== 0) {
      await this.movementsService.logMovement({
        inventoryItem: id,
        type: 'INVENTORY_IN',
        countChange: countDifference,
        grossWeightChange: grossWeightDifference,
        netWeightChange: netWeightDifference,
        actionBy: userId,
        reason: `تعديل الجرد للمالك لـ (${updatedItem.title}) - عيار ${updatedItem.karat}`,
      });
    }

    return updatedItem;
  }

  // 4. جلب كافة مجموعات المخزون
  async findAll(
    status: string = 'ACTIVE',
    karat?: number,
    companyName?: string,
  ): Promise<any[]> {
    const isArchivedQuery = status.toUpperCase() === 'ARCHIVED';
    const filter: any = { isArchived: isArchivedQuery };

    if (karat) filter.karat = karat;
    if (companyName) {
      if (companyName === '-') {
        filter.companyName = '-';
      } else {
        filter.companyName = { $regex: companyName, $options: 'i' };
      }
    }

    const items = await this.inventoryModel
      .find(filter)
      .populate('category', 'name')
      .sort({ createdAt: -1 })
      .exec();

    return items.map((item) => {
      const itemObj: any = item.toObject();
      if (!itemObj.category) {
        itemObj.category = { _id: null, name: 'غير محدد' };
      }
      return itemObj;
    });
  }

  // 5. جلب مجموعة بالـ ID
  async findById(id: string): Promise<any> {
    const item = await this.inventoryModel
      .findOne({ _id: id, isArchived: false })
      .populate('category', 'name')
      .exec();

    if (!item) {
      throw new NotFoundException('مجموعة الذهب هذه غير موجودة في المخزن');
    }

    const itemObj: any = item.toObject();
    if (!itemObj.category) {
      itemObj.category = { _id: null, name: 'غير محدد' };
    }

    return itemObj;
  }

  // 6. أرشفة ناعمة
  async softDelete(id: string): Promise<void> {
    const item = await this.inventoryModel
      .findOne({ _id: id, isArchived: false })
      .exec();

    if (!item) {
      throw new NotFoundException('المجموعة غير موجودة أو مؤرشفة بالفعل');
    }

    if (item.currentCount > 0) {
      throw new BadRequestException(
        'لا يمكن أرشفة مجموعة مخزون لا تزال تحتوي على قطع غير مباعة!',
      );
    }

    await this.inventoryModel
      .updateOne({ _id: id }, { isArchived: true })
      .exec();
  }
}
