Component({
  properties: {
    // 中心节点数据
    centerNode: {
      type: Object,
      value: {
        code: '',
        name: '标准名称加载中...',
        total_relations: 0
      }
    },
    // 四个统计卡片
    relationMetrics: {
      type: Object,
      value: null
    },
    // 版本演进链
    replacementChain: {
      type: Array,
      value: []
    },
    // 相关标准列表
    relatedNodes: {
      type: Array,
      value: []
    },
    // 系列分册列表
    libraryStandards: {
      type: Array,
      value: []
    },
    // 系列描述文案
    citedSummary: {
      type: String,
      value: ''
    }
  },

  data: {
    relationNodes: [], // 计算后的关系节点坐标
    activeType: null,  // 当前选中的详情类型
    activeTitle: ''    // 详情面板标题
  },

  lifetimes: {
    attached() {
      this.initGraph();
    }
  },

  observers: {
    'relationMetrics, replacementChain, relatedNodes, libraryStandards': function() {
      this.initGraph();
    }
  },

  methods: {
    // 初始化图谱节点位置
    initGraph() {
      const { relationMetrics } = this.properties;
      if (!relationMetrics) return;

      const nodes = [];
      const configs = [
        { type: 'versions', label: '历史版本', count: relationMetrics.versionCount || 0, angle: -45, distance: 220 },
        { type: 'series', label: '系列分册', count: relationMetrics.seriesCount || 0, angle: 135, distance: 220 },
        { type: 'similar', label: '相关标准', count: relationMetrics.similarCount || 0, angle: 225, distance: 220 },
        { type: 'total', label: '总关联', count: relationMetrics.totalCount || 0, angle: 45, distance: 220 }
      ];

      configs.forEach(config => {
        if (config.count > 0 || config.type === 'total') {
          const radian = (config.angle * Math.PI) / 180;
          const x = Math.cos(radian) * config.distance;
          const y = Math.sin(radian) * config.distance;
          nodes.push({
            type: config.type,
            label: config.label,
            count: config.count,
            x,
            y,
            offsetX: x - 60,
            offsetY: y - 60,
            angle: config.angle,
            lineAngle: (config.angle + 180) % 360,
            lineWidth: Math.max(config.distance - 120, 36)
          });
        }
      });

      this.setData({ relationNodes: nodes });
    },

    // 处理节点点击
    onNodeTap(e) {
      const { type, label } = e.currentTarget.dataset;

      this.setData({
        activeType: type,
        activeTitle: label
      });
    },

    // 详情列表项点击 → 触发事件让页面处理导航
    onItemTap(e) {
      const code = e.currentTarget.dataset.code;
      this.triggerEvent('itemtap', { code });
    },

    // 关闭详情面板
    closeDetail() {
      this.setData({
        activeType: null,
        activeTitle: ''
      });
    }
  }
});
