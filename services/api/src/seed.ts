/**
 * 种子数据初始化
 * @date   2026-03-21
 */
import { prisma } from './db'

async function main() {
  const exists = await prisma.standard.count()
  if (exists > 0) return

  const standard = await prisma.standard.create({
    data: {
      code: 'STD-001',
      title: '食品安全国家标准',
      level: '国家',
      source: 'openstd',
      version: '2023',
      scope: '食品'
    }
  })

  const category = await prisma.category.create({
    data: {
      name: '食品'
    }
  })

  const indicatorPathogen = await prisma.indicator.create({
    data: {
      indicatorId: 'PATHOGEN',
      name: '致病菌检出',
      defaultUnit: '次',
      dimension: 'safety',
      synonyms: JSON.stringify(['pathogen', 'pathogenic_bacteria'])
    }
  })

  const indicatorPreservative = await prisma.indicator.create({
    data: {
      indicatorId: 'PRESERVATIVE',
      name: '防腐剂',
      defaultUnit: 'g/kg',
      dimension: 'quality',
      synonyms: JSON.stringify(['preservative'])
    }
  })

  await prisma.standardClause.createMany({
    data: [
      {
        standardId: standard.id,
        key: '微生物',
        requirement: '不得检出致病菌',
        indicator: '致病菌检出',
        indicatorId: indicatorPathogen.id,
        comparator: '=',
        threshold: 0,
        unit: '次',
        weight: 0.4,
        veto: true
      },
      {
        standardId: standard.id,
        key: '添加剂',
        requirement: '符合限量要求',
        indicator: '防腐剂',
        indicatorId: indicatorPreservative.id,
        comparator: '<=',
        threshold: 0.5,
        unit: 'g/kg',
        weight: 0.3
      }
    ]
  })

  await prisma.ruleSet.create({
    data: {
      name: '默认评分',
      strategy: '加权平均',
      weights: JSON.stringify({ 质量标准: 0.4, 安全标准: 0.35, 环保标准: 0.25 }),
      expression: JSON.stringify({ op: 'avg', args: [{ var: '质量标准' }, { var: '安全标准' }, { var: '环保标准' }] })
    }
  })

  const products = [
    {
      name: '蒙牛纯牛奶',
      barcode: '6901028075831',
      brand: '蒙牛'
    },
    {
      name: '伊利金典有机纯牛奶',
      barcode: '6902083898236',
      brand: '伊利'
    },
    {
      name: '三只松鼠每日坚果',
      barcode: '6921168518616',
      brand: '三只松鼠'
    }
  ]

  for (const item of products) {
    const product = await prisma.product.create({
      data: {
        name: item.name,
        brand: item.brand,
        barcode: item.barcode,
        category: '食品',
        categoryId: category.id
      }
    })

    await prisma.productMapping.create({
      data: {
        productId: product.id,
        type: '条码',
        value: item.barcode,
        priority: 1,
        standardIds: JSON.stringify(['STD-001'])
      }
    })

    const report = await prisma.report.create({
      data: {
        productId: product.id,
        reportNo: `TEST-${item.barcode.slice(-4)}`,
        org: '国家食品质量监督检验中心',
        date: new Date('2024-01-15'),
        sourceType: 'third-party',
        trustLevel: 'third-party',
        fileUrl: 'https://example.com/report.pdf'
      }
    })

    await prisma.measurement.createMany({
      data: [
        {
          reportId: report.id,
          indicatorId: indicatorPathogen.id,
          rawName: '致病菌检出',
          rawValue: 0,
          rawUnit: '次',
          valueStd: 0,
          unitStd: '次',
          mappingConfidence: 0.9
        },
        {
          reportId: report.id,
          indicatorId: indicatorPreservative.id,
          rawName: '防腐剂',
          rawValue: item.barcode === '6902083898236' ? 0.28 : item.barcode === '6921168518616' ? 0.42 : 0.32,
          rawUnit: 'g/kg',
          valueStd: item.barcode === '6902083898236' ? 0.28 : item.barcode === '6921168518616' ? 0.42 : 0.32,
          unitStd: 'g/kg',
          mappingConfidence: 0.9
        }
      ]
    })
  }

  await prisma.peerBaseline.createMany({
    data: [
      {
        categoryId: category.id,
        indicatorId: indicatorPathogen.id,
        avg: 0.1,
        p50: 0.05,
        p75: 0.2,
        p90: 0.3,
        source: 'industry'
      },
      {
        categoryId: category.id,
        indicatorId: indicatorPreservative.id,
        avg: 0.35,
        p50: 0.3,
        p75: 0.4,
        p90: 0.45,
        source: 'industry'
      }
    ]
  })

  const standard2 = await prisma.standard.create({
    data: {
      code: 'STD-002',
      title: '调味品行业标准',
      level: '行业',
      source: 'industry',
      version: '2022',
      scope: '调味品'
    }
  })

  await prisma.standardClause.createMany({
    data: [
      {
        standardId: standard2.id,
        key: '钠含量',
        requirement: '钠含量不高于标准',
        indicator: '钠含量',
        comparator: '<=',
        threshold: 600,
        unit: 'mg/100g',
        weight: 0.5,
        veto: false
      },
      {
        standardId: standard2.id,
        key: '重金属',
        requirement: '重金属含量不得超标',
        indicator: '重金属',
        comparator: '<=',
        threshold: 0.2,
        unit: 'mg/kg',
        weight: 0.5,
        veto: true
      }
    ]
  })

  const product2 = await prisma.product.create({
    data: {
      name: '示例番茄酱',
      barcode: '6909876543210'
    }
  })

  await prisma.productMapping.create({
    data: {
      productId: product2.id,
      type: '条码',
      value: '6909876543210',
      priority: 1,
      standardIds: JSON.stringify(['STD-002'])
    }
  })

  await prisma.productionStandard.create({
    data: {
      productId: product2.id,
      standardId: standard2.id,
      dataSource: 'manual',
      reportItems: {
        create: [
          { indicator: '钠含量', value: 580, unit: 'mg/100g', result: '合格' },
          { indicator: '重金属', value: 0.15, unit: 'mg/kg', result: '合格' }
        ]
      }
    }
  })

  await prisma.auditTask.create({
    data: {
      title: '食品安全国家标准（抓取）',
      source: 'openstd.samr.gov.cn',
      status: '待审核'
    }
  })

  await prisma.standardContent.create({
    data: {
      standardId: standard.id,
      header: JSON.stringify({
        code: 'STD-001',
        title: '食品安全国家标准',
        titleEn: 'National Food Safety Standard',
        ics: 'ICS 67.040',
        classification: 'X 09',
        issuedAt: '2023-01-01',
        effectiveAt: '2023-07-01',
        publisher: '国家卫生健康委员会'
      }),
      toc: JSON.stringify([
        { no: '1', title: '范围', page: 1 },
        { no: '2', title: '规范性引用文件', page: 1 },
        { no: '3', title: '术语和定义', page: 2 }
      ]),
      preface: '本标准为食品安全通用要求示例，用于演示结构化入库。',
      intro: '本标准适用于食品生产与流通环节的质量控制。',
      sections: JSON.stringify([
        { no: '1', title: '范围', content: '本标准规定食品安全管理的基本要求。' },
        { no: '2', title: '规范性引用文件', content: '引用相关食品安全标准文件。' }
      ]),
      figures: JSON.stringify([]),
      tables: JSON.stringify([]),
      references: JSON.stringify(['GB 14881', 'GB 2760'])
    }
  })

  const scene = await prisma.scene.create({
    data: {
      name: '安全生产 SOP 示例',
      type: 'SOP',
      industry: '工程建设',
      description: '高风险作业 SOP 执行流程示例',
      status: '启用'
    }
  })

  await prisma.sceneModule.createMany({
    data: [
      {
        sceneId: scene.id,
        moduleType: 'STEP',
        title: '启动前检查',
        sortOrder: 1,
        payload: JSON.stringify({ checklist: ['检查压力表', '确认无泄漏', '佩戴防护装备'] })
      },
      {
        sceneId: scene.id,
        moduleType: 'CONTENT',
        title: '风险提示',
        sortOrder: 2,
        payload: JSON.stringify({ level: '高风险', note: '未确认设备状态禁止启动' })
      }
    ]
  })

  await prisma.sceneStandardBinding.create({
    data: {
      sceneId: scene.id,
      standardId: standard.id,
      relation: 'BASIS'
    }
  })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
