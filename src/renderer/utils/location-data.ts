/**
 * 游戏地点层级数据
 *
 * 数据来源：上游 nikki_albums 项目 rust/src/nuan5_params/structs/world.rs
 * 层级：Dimension（维度）→ Nation（国家）→ Region（区域）→ Area（地区）→ Subarea（子区域）
 * 上游 location_parser.rs 中坐标→地点映射为 // todo 空壳，此数据用于：
 * 1. 提供完整地名分类供手动坐标映射
 * 2. 配合 location-map.ts 的自动收集机制
 */

export interface WorldSubarea {
  name: string
  nameKey: string
}

export interface WorldArea {
  name: string
  nameKey: string
  subareas: WorldSubarea[]
}

export interface WorldRegion {
  name: string
  nameKey: string
  areas: WorldArea[]
}

export interface WorldNation {
  name: string
  nameKey: string
  regions: WorldRegion[]
}

export interface WorldDimension {
  name: string
  nameKey: string
  nations?: WorldNation[]
  subareas?: WorldSubarea[]
}

export const WORLD_LOCATIONS: WorldDimension[] = [
  {
    name: 'Miraland',
    nameKey: 'locations.Miraland',
    nations: [
      {
        name: 'HeartcraftKingdom',
        nameKey: 'locations.HeartcraftKingdom',
        regions: [
          {
            name: 'Wishfield',
            nameKey: 'locations.Wishfield',
            areas: [
              {
                name: 'MemorialMountains',
                nameKey: 'locations.MemorialMountains',
                subareas: [
                  { name: 'OldFlorawishMemorial', nameKey: 'locations.OldFlorawishMemorial' },
                  { name: 'StylistGuildMemorial', nameKey: 'locations.StylistGuildMemorial' }
                ]
              },
              {
                name: 'Florawish',
                nameKey: 'locations.Florawish',
                subareas: [
                  { name: 'DreamwovenRuins', nameKey: 'locations.DreamwovenRuins' },
                  { name: 'FortuneFalls', nameKey: 'locations.FortuneFalls' },
                  { name: 'GreatWishtreeSquare', nameKey: 'locations.GreatWishtreeSquare' },
                  { name: 'LakesideDistrict', nameKey: 'locations.LakesideDistrict' },
                  { name: 'OutskirtsForest', nameKey: 'locations.OutskirtsForest' }
                ]
              },
              {
                name: 'BreezyMeadow',
                nameKey: 'locations.BreezyMeadow',
                subareas: [
                  {
                    name: 'AbandonedFanaticWisherCamp',
                    nameKey: 'locations.AbandonedFanaticWisherCamp'
                  },
                  {
                    name: 'BreezyMeadowActivityArea',
                    nameKey: 'locations.BreezyMeadowActivityArea'
                  },
                  { name: 'BugSongHills', nameKey: 'locations.BugSongHills' },
                  { name: 'CiciaHighlands', nameKey: 'locations.CiciaHighlands' },
                  {
                    name: 'HeartcraftKingdomOutpost',
                    nameKey: 'locations.HeartcraftKingdomOutpost'
                  },
                  { name: 'LakesideHill', nameKey: 'locations.LakesideHill' },
                  { name: 'MeadowWharf', nameKey: 'locations.MeadowWharf' },
                  { name: 'QueenPalaceRuins', nameKey: 'locations.QueenPalaceRuins' },
                  { name: 'RelicHill', nameKey: 'locations.RelicHill' },
                  { name: 'SleepyFishHills', nameKey: 'locations.SleepyFishHills' },
                  { name: 'SwanGazebo', nameKey: 'locations.SwanGazebo' }
                ]
              },
              {
                name: 'Stoneville',
                nameKey: 'locations.Stoneville',
                subareas: [
                  { name: 'DyeWorkshop', nameKey: 'locations.DyeWorkshop' },
                  { name: 'FlowerFieldsResidence', nameKey: 'locations.FlowerFieldsResidence' },
                  { name: 'RockfallValley', nameKey: 'locations.RockfallValley' },
                  { name: 'StonevilleMarket', nameKey: 'locations.StonevilleMarket' }
                ]
              },
              {
                name: 'AbandonedDistrict',
                nameKey: 'locations.AbandonedDistrict',
                subareas: [
                  { name: 'ChooChooStation', nameKey: 'locations.ChooChooStation' },
                  { name: 'GoldenFields', nameKey: 'locations.GoldenFields' },
                  { name: 'MarketOfMirth', nameKey: 'locations.MarketOfMirth' },
                  { name: 'Prosperville', nameKey: 'locations.Prosperville' },
                  { name: 'RippleEstate', nameKey: 'locations.RippleEstate' },
                  { name: 'StellarFishingGround', nameKey: 'locations.StellarFishingGround' },
                  { name: 'Stonecrown', nameKey: 'locations.Stonecrown' },
                  { name: 'WindriderMill', nameKey: 'locations.WindriderMill' }
                ]
              },
              {
                name: 'WishingWoods',
                nameKey: 'locations.WishingWoods',
                subareas: [
                  { name: 'BrookwoodForest', nameKey: 'locations.BrookwoodForest' },
                  { name: 'CavernOfWishes', nameKey: 'locations.CavernOfWishes' },
                  { name: 'FallenWishHighlands', nameKey: 'locations.FallenWishHighlands' },
                  { name: 'GrandTreeValley', nameKey: 'locations.GrandTreeValley' },
                  { name: 'SacredMountains', nameKey: 'locations.SacredMountains' },
                  { name: 'ValleyOfBlossoms', nameKey: 'locations.ValleyOfBlossoms' }
                ]
              },
              {
                name: 'FireworkIsles',
                nameKey: 'locations.FireworkIsles',
                subareas: [
                  { name: 'ClearheartLake', nameKey: 'locations.ClearheartLake' },
                  { name: 'CrescentMoonRuins', nameKey: 'locations.CrescentMoonRuins' },
                  { name: 'FlamingForest', nameKey: 'locations.FlamingForest' },
                  { name: 'RelicIsles', nameKey: 'locations.RelicIsles' },
                  { name: 'SongbreezeHighland', nameKey: 'locations.SongbreezeHighland' },
                  { name: 'SparkheartIsland', nameKey: 'locations.SparkheartIsland' }
                ]
              },
              {
                name: 'SerenityIsland',
                nameKey: 'locations.SerenityIsland',
                subareas: [
                  { name: 'OldRuins', nameKey: 'locations.OldRuins' },
                  { name: 'Soakville', nameKey: 'locations.Soakville' },
                  { name: 'SoakvilleOutskirts', nameKey: 'locations.SoakvilleOutskirts' },
                  { name: 'Steamville', nameKey: 'locations.Steamville' }
                ]
              },
              {
                name: 'DanqingIsland',
                nameKey: 'locations.DanqingIsland',
                subareas: [
                  { name: 'BackMountain', nameKey: 'locations.BackMountain' },
                  { name: 'BambooGrove', nameKey: 'locations.BambooGrove' },
                  { name: 'Inkville', nameKey: 'locations.Inkville' },
                  { name: 'InkwashStream', nameKey: 'locations.InkwashStream' },
                  { name: 'LoongPagoda', nameKey: 'locations.LoongPagoda' },
                  { name: 'LoongPeak', nameKey: 'locations.LoongPeak' },
                  { name: 'ReedblossomShore', nameKey: 'locations.ReedblossomShore' }
                ]
              },
              {
                name: 'DanqingRealm',
                nameKey: 'locations.DanqingRealm',
                subareas: [
                  { name: 'GreenBambooGrove', nameKey: 'locations.GreenBambooGrove' },
                  { name: 'InkPool', nameKey: 'locations.InkPool' },
                  { name: 'InkshorePlain', nameKey: 'locations.InkshorePlain' },
                  { name: 'Inkville', nameKey: 'locations.Inkville' },
                  { name: 'WildfieldWaterside', nameKey: 'locations.WildfieldWaterside' }
                ]
              }
            ]
          }
        ]
      },
      {
        name: 'TerraAlliance',
        nameKey: 'locations.TerraAlliance',
        regions: [
          {
            name: 'Itzaland',
            nameKey: 'locations.Itzaland',
            areas: [
              {
                name: 'ItzalandCanyon',
                nameKey: 'locations.ItzalandCanyon',
                subareas: []
              },
              {
                name: 'ElderwoodForest',
                nameKey: 'locations.ElderwoodForest',
                subareas: [
                  { name: 'BehemothObservationSite', nameKey: 'locations.BehemothObservationSite' },
                  { name: 'Coliseum', nameKey: 'locations.Coliseum' },
                  { name: 'ElderwoodShade', nameKey: 'locations.ElderwoodShade' },
                  { name: 'ElderwoodWharf', nameKey: 'locations.ElderwoodWharf' },
                  { name: 'ForestOfSlumber', nameKey: 'locations.ForestOfSlumber' },
                  { name: 'ForgottenStreet', nameKey: 'locations.ForgottenStreet' },
                  { name: 'GiantVineForest', nameKey: 'locations.GiantVineForest' },
                  { name: 'LeafRiver', nameKey: 'locations.LeafRiver' },
                  { name: 'MothershroomWoods', nameKey: 'locations.MothershroomWoods' },
                  { name: 'ParkyaCraterLake', nameKey: 'locations.ParkyaCraterLake' },
                  { name: 'Pottsville', nameKey: 'locations.Pottsville' },
                  { name: 'RockvilleRuins', nameKey: 'locations.RockvilleRuins' },
                  { name: 'ShellIsland', nameKey: 'locations.ShellIsland' },
                  { name: 'Shroomville', nameKey: 'locations.Shroomville' },
                  { name: 'SnailRanch', nameKey: 'locations.SnailRanch' },
                  { name: 'SpiraWaterfall', nameKey: 'locations.SpiraWaterfall' },
                  { name: 'TitanGraveyard', nameKey: 'locations.TitanGraveyard' },
                  { name: 'TitansOutpostRuins', nameKey: 'locations.TitansOutpostRuins' }
                ]
              },
              {
                name: 'Spira',
                nameKey: 'locations.Spira',
                subareas: [
                  { name: 'Spira1F', nameKey: 'locations.Spira1F' },
                  { name: 'Spira2F', nameKey: 'locations.Spira2F' },
                  { name: 'Spira3F', nameKey: 'locations.Spira3F' },
                  { name: 'SpiraShelldome', nameKey: 'locations.SpiraShelldome' }
                ]
              },
              {
                name: 'Boneyard',
                nameKey: 'locations.Boneyard',
                subareas: [
                  { name: 'BluePools', nameKey: 'locations.BluePools' },
                  { name: 'Cultivarium', nameKey: 'locations.Cultivarium' },
                  { name: 'DragonRuins', nameKey: 'locations.DragonRuins' },
                  { name: 'DragonrestFlowerfield', nameKey: 'locations.DragonrestFlowerfield' },
                  { name: 'GlimmeringLake', nameKey: 'locations.GlimmeringLake' },
                  { name: 'GreatLumieville', nameKey: 'locations.GreatLumieville' },
                  { name: 'HealingGround', nameKey: 'locations.HealingGround' },
                  { name: 'HollowbreathPassage', nameKey: 'locations.HollowbreathPassage' },
                  { name: 'LonestoneShore', nameKey: 'locations.LonestoneShore' },
                  { name: 'SoulSpring', nameKey: 'locations.SoulSpring' }
                ]
              },
              {
                name: 'WanxiangRealm',
                nameKey: 'locations.WanxiangRealm',
                subareas: [
                  { name: 'BackMountain', nameKey: 'locations.BackMountain' },
                  { name: 'CaiYeMarket', nameKey: 'locations.CaiYeMarket' },
                  { name: 'CaiYeOutskirts', nameKey: 'locations.CaiYeOutskirts' },
                  { name: 'DazzlebloomMeadow', nameKey: 'locations.DazzlebloomMeadow' },
                  { name: 'DeepValleySpring', nameKey: 'locations.DeepValleySpring' },
                  { name: 'JiuhuaPavilion', nameKey: 'locations.JiuhuaPavilion' },
                  { name: 'JiuhuaPenitentiary', nameKey: 'locations.JiuhuaPenitentiary' },
                  { name: 'ValleyPath', nameKey: 'locations.ValleyPath' },
                  { name: 'WhereWoodEchoes', nameKey: 'locations.WhereWoodEchoes' }
                ]
              }
            ]
          }
        ]
      },
      {
        name: 'EmpireOfLight',
        nameKey: 'locations.EmpireOfLight',
        regions: []
      },
      {
        name: 'StarhailFederation',
        nameKey: 'locations.StarhailFederation',
        regions: []
      },
      {
        name: 'LinlangEmpire',
        nameKey: 'locations.LinlangEmpire',
        regions: []
      },
      {
        name: 'TwinmoonKingdom',
        nameKey: 'locations.TwinmoonKingdom',
        regions: []
      },
      {
        name: 'WhalePort',
        nameKey: 'locations.WhalePort',
        regions: []
      },
      {
        name: 'Umbraso',
        nameKey: 'locations.Umbraso',
        regions: []
      }
    ]
  },
  {
    name: 'SeaOfStars',
    nameKey: 'locations.SeaOfStars',
    subareas: [
      { name: 'Crystalvale', nameKey: 'locations.Crystalvale' },
      { name: 'DreamStarIsles', nameKey: 'locations.DreamStarIsles' },
      { name: 'Starshore', nameKey: 'locations.Starshore' },
      { name: 'UnboundWharf', nameKey: 'locations.UnboundWharf' }
    ]
  },
  {
    name: 'Home',
    nameKey: 'locations.Home',
    subareas: [{ name: 'DockArea', nameKey: 'locations.DockArea' }]
  }
]

/** 扁平化所有地点 key，供搜索使用 */
export function getAllLocationNames(): string[] {
  const names: string[] = []
  for (const dim of WORLD_LOCATIONS) {
    names.push(dim.nameKey)
    if (dim.nations) {
      for (const nation of dim.nations) {
        names.push(nation.nameKey)
        for (const region of nation.regions) {
          names.push(region.nameKey)
          for (const area of region.areas) {
            names.push(area.nameKey)
            for (const sub of area.subareas) {
              names.push(sub.nameKey)
            }
          }
        }
      }
    }
    if (dim.subareas) {
      for (const sub of dim.subareas) {
        names.push(sub.nameKey)
      }
    }
  }
  return names
}

/** 根据 i18n key 查找完整路径（返回 key 数组，调用方需用 t() 解析） */
export function findLocationPath(nameKey: string): string[] | null {
  for (const dim of WORLD_LOCATIONS) {
    if (dim.nameKey === nameKey) return [dim.nameKey]
    if (dim.nations) {
      for (const nation of dim.nations) {
        if (nation.nameKey === nameKey) return [dim.nameKey, nation.nameKey]
        for (const region of nation.regions) {
          if (region.nameKey === nameKey) return [dim.nameKey, nation.nameKey, region.nameKey]
          for (const area of region.areas) {
            if (area.nameKey === nameKey)
              return [dim.nameKey, nation.nameKey, region.nameKey, area.nameKey]
            for (const sub of area.subareas) {
              if (sub.nameKey === nameKey)
                return [dim.nameKey, nation.nameKey, region.nameKey, area.nameKey, sub.nameKey]
            }
          }
        }
      }
    }
    if (dim.subareas) {
      for (const sub of dim.subareas) {
        if (sub.nameKey === nameKey) return [dim.nameKey, sub.nameKey]
      }
    }
  }
  return null
}
